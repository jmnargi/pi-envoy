/**
 * src/worktrees.ts — isolated working trees for delegated subagents (§4.7
 * boundaries, privilege attenuation through workspace isolation).
 *
 * Every git invocation runs through `git -C <resolvedRoot>` with spawn
 * argument arrays (never shell interpolation, never string-built commands),
 * and every path handed to git comes from this module or a verified caller.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { WorktreeInfo } from "./types.ts";

/**
 * Resolve `repoDir` (which may be any subdirectory of the repository) to the
 * repository root. Throws when `repoDir` is not inside a git repository.
 */
function resolveRepo(repoDir: string): string {
	const res = spawnSync("git", ["-C", repoDir, "rev-parse", "--show-toplevel"], {
		shell: false,
		encoding: "utf8",
	});
	if (res.status !== 0 || !res.stdout) {
		throw new Error(`not a git repository (or worktree): ${repoDir}`);
	}
	return String(res.stdout).trim();
}

interface GitResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Run git with an argument array; resolves with stdout/stderr/exit code. */
function runGit(args: string[], cwd: string): Promise<GitResult> {
	return new Promise((resolveResult) => {
		const proc = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("close", (code) => resolveResult({ code, stdout, stderr }));
		proc.on("error", (err) => resolveResult({ code: null, stdout, stderr: stderr + err.message }));
	});
}

/**
 * Restrict a branch name to git-safe characters: anything outside
 * `[a-zA-Z0-9._/-]` becomes `-` and repeated slashes collapse to one.
 * Throws when nothing survives sanitization.
 */
function sanitizeBranch(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/\/{2,}/g, "/");
	if (!sanitized) throw new Error(`invalid branch name: ${name}`);
	return sanitized;
}

/**
 * Create a worktree on a fresh `subagent/<id>` branch (or a caller-provided,
 * sanitized branch) under `<dataDir>/worktrees/<basename(repoRoot)>-<id>`.
 */
export async function createWorktree(
	dataDir: string,
	repoDir: string,
	id: string,
	branch?: string,
): Promise<WorktreeInfo> {
	const root = resolveRepo(repoDir);
	const branchName = sanitizeBranch(branch ?? `subagent/${id}`);

	// Guard: refuse to reuse an existing worktree path or branch.
	const worktreesDir = join(dataDir, "worktrees");
	const worktreePath = join(worktreesDir, `${basename(root)}-${id}`);
	for (const wt of await listWorktrees(root)) {
		if (resolve(wt.path) === resolve(worktreePath)) {
			throw new Error(`worktree already exists at ${worktreePath}`);
		}
		if (wt.branch === branchName) {
			throw new Error(`worktree for branch ${branchName} already exists`);
		}
	}

	mkdirSync(worktreesDir, { recursive: true });

	const res = await runGit(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], root);
	if (res.code !== 0) {
		throw new Error(`git worktree add failed: ${(res.stderr || res.stdout).trim()}`);
	}

	return { path: worktreePath, branch: branchName, repoRoot: root };
}

/** List a repository's worktrees (`git worktree list --porcelain`). */
export async function listWorktrees(repoDir: string): Promise<WorktreeInfo[]> {
	const root = resolveRepo(repoDir);
	const res = await runGit(["worktree", "list", "--porcelain"], root);
	if (res.code !== 0) {
		throw new Error(`git worktree list failed: ${(res.stderr || res.stdout).trim()}`);
	}

	const infos: WorktreeInfo[] = [];
	for (const block of res.stdout.split(/\n\s*\n/)) {
		const lines = block.split("\n").map((line) => line.trim());
		const worktreeLine = lines.find((line) => line.startsWith("worktree "));
		if (!worktreeLine) continue;
		const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
		infos.push({
			path: worktreeLine.slice("worktree ".length),
			branch: branchLine ? branchLine.slice("branch refs/heads/".length) : "detached",
			repoRoot: root,
		});
	}
	return infos;
}

/**
 * Remove a worktree. With `keep: true` this is a no-op (used when a failed
 * run should keep its tree for inspection). Refuses to touch anything outside
 * `<dataDir>/worktrees/`, and prunes after a successful removal.
 */
export async function removeWorktree(
	dataDir: string,
	repoDir: string,
	worktreePath: string,
	opts: { keep?: boolean } = {},
): Promise<void> {
	if (opts.keep) return;

	const root = resolveRepo(repoDir);
	const worktreesDir = resolve(join(dataDir, "worktrees"));
	const target = resolve(worktreePath);
	if (target !== worktreesDir && !target.startsWith(worktreesDir + sep)) {
		throw new Error(`refusing to remove path outside worktrees dir: ${worktreePath}`);
	}
	if (!existsSync(target)) {
		throw new Error(`worktree path does not exist: ${worktreePath}`);
	}

	const res = await runGit(["worktree", "remove", "--force", worktreePath], root);
	if (res.code !== 0) {
		// If the worktree directory vanished while removing, treat it as done.
		if (!existsSync(target)) {
			await prune(root);
			return;
		}
		throw new Error(`git worktree remove failed: ${(res.stderr || res.stdout).trim()}`);
	}
	await prune(root);
}

/**
 * Merge the child `branch` into the main working tree at `cwd` (the caller
 * passes the already-resolved main tree root). Never touches the tree when
 * the merge conflicts — the caller decides how to resolve.
 */
export async function mergeBack(
	repoDir: string,
	branch: string,
	opts: { cwd: string },
): Promise<{ ok: boolean; output: string; conflicted: boolean }> {
	const res = await runGit(["merge", "--no-edit", branch], opts.cwd);
	const output = `${res.stdout}${res.stderr}`.trim();
	if (res.code === 0) return { ok: true, output, conflicted: false };
	return { ok: false, output, conflicted: output.toUpperCase().includes("CONFLICT") };
}

/** `git worktree prune` — clean up stale worktree admin data; errors ignored. */
export async function prune(repoDir: string): Promise<void> {
	const root = resolveRepo(repoDir);
	await runGit(["worktree", "prune"], root);
}
