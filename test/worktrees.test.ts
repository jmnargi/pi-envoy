/**
 * test/worktrees.test.ts — coverage for src/worktrees.ts git worktree
 * isolation (§4.7 boundaries): creation on subagent branches, cross-tree
 * isolation, listing, safe removal (keep/prune/boundary guards), and
 * merge-back including conflict detection.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWorktree, listWorktrees, mergeBack, prune, removeWorktree } from "../src/worktrees.ts";

let gitAvailable = true;
try {
	execFileSync("git", ["--version"], { stdio: "pipe" });
} catch {
	gitAvailable = false;
}

const suiteRoot = mkdtempSync(join(tmpdir(), "pi-envoy-worktrees-"));

const run = gitAvailable ? test : test.skip;

afterAll(() => {
	rmSync(suiteRoot, { recursive: true, force: true });
});

/** A fresh repo with one committed file, plus an empty, separate dataDir. */
function freshRepo(): { repoRoot: string; dataDir: string } {
	const repoRoot = mkdtempSync(join(suiteRoot, "repo-"));
	const dataDir = mkdtempSync(join(suiteRoot, "data-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
	execFileSync("git", ["config", "user.name", "Pi Subagents Test"], { cwd: repoRoot, stdio: "pipe" });
	execFileSync("git", ["config", "user.email", "test@pi-envoy.invalid"], { cwd: repoRoot, stdio: "pipe" });
	writeFileSync(join(repoRoot, "base.txt"), "base\n");
	execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
	return { repoRoot, dataDir };
}

/** Commit a file inside a (possibly worktree) checkout. */
function commitFile(tree: string, name: string, contents: string, message: string): void {
	writeFileSync(join(tree, name), contents);
	execFileSync("git", ["add", "."], { cwd: tree, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", message], { cwd: tree, stdio: "pipe" });
}

beforeAll(() => {
	if (!gitAvailable) return;
	execFileSync("git", ["--version"], { stdio: "pipe" });
});

describe("worktrees", () => {
	run("createWorktree creates an isolated tree on subagent/<id>", async () => {
		const { repoRoot, dataDir } = freshRepo();
		const wt = await createWorktree(dataDir, repoRoot, "sa_x");

		expect(wt.branch).toBe("subagent/sa_x");
		expect(wt.repoRoot).toBe(repoRoot);
		expect(wt.path.startsWith(join(dataDir, "worktrees"))).toBe(true);

		// A new file in the worktree must not appear in the main tree.
		writeFileSync(join(wt.path, "worktree-only.txt"), "child\n");
		expect(existsSync(join(repoRoot, "worktree-only.txt"))).toBe(false);

		// Committing in the worktree publishes the subagent branch.
		commitFile(wt.path, "worktree-only.txt", "child\n", "child change");
		const log = execFileSync("git", ["log", "--oneline", "-1", "subagent/sa_x"], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		expect(log).toContain("child change");
	});

	run("repoDir may be a subdirectory (resolved to the repository root)", async () => {
		const { repoRoot, dataDir } = freshRepo();
		mkdirSync(join(repoRoot, "sub"));
		const wt = await createWorktree(dataDir, join(repoRoot, "sub"), "sa_sub");
		expect(wt.repoRoot).toBe(repoRoot);
		expect(wt.branch).toBe("subagent/sa_sub");
	});

	run("listWorktrees finds main and created worktrees; duplicates are rejected", async () => {
		const { repoRoot, dataDir } = freshRepo();
		const wt1 = await createWorktree(dataDir, repoRoot, "sa_y");
		const wt2 = await createWorktree(dataDir, repoRoot, "sa_z");

		const list = await listWorktrees(repoRoot);
		expect(list.find((w) => w.branch === "subagent/sa_y")?.path).toBe(wt1.path);
		expect(list.find((w) => w.branch === "subagent/sa_z")?.path).toBe(wt2.path);

		// The main checkout reports its own branch; bare worktrees would
		// have no `branch` line in --porcelain and fall back to "detached".
		expect(list.find((w) => w.path === repoRoot)?.branch).toBe("main");

		// Reusing an id (same path) or an existing branch must throw.
		await expect(createWorktree(dataDir, repoRoot, "sa_y")).rejects.toThrow();
		await expect(createWorktree(dataDir, repoRoot, "sa_dup", "subagent/sa_z")).rejects.toThrow();
	});

	run("removeWorktree honors keep and prunes on removal", async () => {
		const { repoRoot, dataDir } = freshRepo();
		const kept = await createWorktree(dataDir, repoRoot, "sa_k");
		await removeWorktree(dataDir, repoRoot, kept.path, { keep: true });
		expect(existsSync(kept.path)).toBe(true);

		const gone = await createWorktree(dataDir, repoRoot, "sa_d");
		await removeWorktree(dataDir, repoRoot, gone.path, {});
		expect(existsSync(gone.path)).toBe(false);

		const list = await listWorktrees(repoRoot);
		expect(list.map((w) => w.path)).not.toContain(gone.path);

		// Prune runs automatically after removal; an explicit prune is a no-op.
		await prune(repoRoot);
		await expect(listWorktrees(repoRoot)).resolves.toBeDefined();
	});

	run("removeWorktree rejects paths outside the dataDir worktrees directory", async () => {
		const { repoRoot, dataDir } = freshRepo();
		await expect(removeWorktree(dataDir, repoRoot, "/etc/hosts")).rejects.toThrow();
		await expect(removeWorktree(dataDir, repoRoot, "/")).rejects.toThrow();
		const outside = mkdtempSync(join(dataDir, "elsewhere-"));
		await expect(removeWorktree(dataDir, repoRoot, outside)).rejects.toThrow();
		await expect(removeWorktree(dataDir, repoRoot, join(dataDir, "worktrees", "missing"))).rejects.toThrow();
	});

	run("mergeBack merges the child branch into the main tree", async () => {
		const { repoRoot, dataDir } = freshRepo();
		const wt = await createWorktree(dataDir, repoRoot, "sa_m");
		commitFile(wt.path, "feature.txt", "feature\n", "feat");

		const res = await mergeBack(repoRoot, wt.branch, { cwd: repoRoot });
		expect(res.ok).toBe(true);
		expect(res.conflicted).toBe(false);
		expect(existsSync(join(repoRoot, "feature.txt"))).toBe(true);
	});

	run("mergeBack reports conflicts without merging", async () => {
		const { repoRoot, dataDir } = freshRepo();
		const wt = await createWorktree(dataDir, repoRoot, "sa_c");
		commitFile(wt.path, "conflict.txt", "worktree version\n", "wt change");
		commitFile(repoRoot, "conflict.txt", "main version\n", "main change");

		const res = await mergeBack(repoRoot, wt.branch, { cwd: repoRoot });
		expect(res.ok).toBe(false);
		expect(res.conflicted).toBe(true);
	});
});
