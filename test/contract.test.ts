/**
 * Tests for the delegation contract renderer (§4.1/§4.2/§4.8): exact section
 * structure, acceptance/verification/reporting/budget lines, file writing and
 * the verify-command runner (success, nonzero exit, timeout).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContractText, runVerify, writeContractFile } from "../src/contract.ts";
import { groupPath, inboxPath, mainInboxPath } from "../src/bus.ts";
import type { AgentProfile, ParentContext, TaskSpec } from "../src/types.ts";

function profile(overrides?: Partial<AgentProfile>): AgentProfile {
	return {
		name: "worker",
		description: "General-purpose worker",
		tools: ["read", "write", "edit", "grep", "glob", "bash"],
		systemPrompt: "You are a worker.",
		source: "project",
		filePath: "/tmp/agents/worker.md",
		...overrides,
	};
}

function makeCtx(dir: string, overrides?: Partial<ParentContext>): ParentContext {
	return {
		id: "sa_delegator",
		parentId: "sa_parent",
		group: "grp_demo",
		depth: 1,
		dataDir: dir,
		inbox: inboxPath(dir, "sa_delegator"),
		mainInbox: mainInboxPath(dir),
		maxDepth: 3,
		...overrides,
	};
}

function baseSpec(overrides?: Partial<TaskSpec>): TaskSpec {
	return {
		agent: "worker",
		objective: "Implement the foo feature end to end.",
		acceptance: ["All tests pass", "README updated"],
		verify: "bun test",
		cwd: "/tmp/work",
		autonomy: "open",
		allowSpawn: true,
		reportCadence: "on-checkpoint",
		group: "grp_demo",
		worktree: true,
		branch: "feat-foo",
		timeoutMs: 120_000,
		maxCostUsd: 1.5,
		...overrides,
	};
}

function render(spec: TaskSpec, dir: string, overrides?: Partial<Parameters<typeof buildContractText>[0]>) {
	const c = makeCtx(dir);
	const outbox = path.join(dir, "bus", "sa_child.out.jsonl");
	return buildContractText({
		spec,
		profile: profile(),
		ctx: c,
		inbox: c.inbox,
		outbox,
		groupChannel: groupPath(dir, "grp_demo"),
		childId: "sa_child",
		...overrides,
	});
}

describe("buildContractText", () => {
	test("renders every section with identity, criteria, block and bounds", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			const text = render(baseSpec(), dir);
			// Identity.
			expect(text).toContain("# Delegation Contract");
			expect(text).toContain("Task ID: sa_child");
			expect(text).toContain("Role: worker");
			expect(text).toContain("Delegator: sa_delegator");
			// Section headings in fixed order.
			const headings = [
				"## Objective",
				"## Scope and boundaries",
				"## Acceptance criteria",
				"## Verification",
				"## Reporting",
				"## Budget and deadline",
			];
			let pos = 0;
			for (const h of headings) {
				const at = text.indexOf(h);
				expect(at).toBeGreaterThanOrEqual(0);
				expect(at).toBeGreaterThan(pos);
				pos = at;
			}
			expect(text.indexOf("— end of contract —")).toBeGreaterThan(pos);
			// Objective verbatim.
			expect(text).toContain("Implement the foo feature end to end.");
			// Scope and boundaries.
			expect(text).toContain("- Working directory: /tmp/work");
			expect(text).toContain("- Allowed tools: read, write, edit, grep, glob, bash");
			expect(text).toContain("- read-only: no");
			expect(text).toContain(
				"- You MAY delegate sub-tasks to sub-subagents using the subagent_* tools.",
			);
			expect(text).toContain("isolated git worktree");
			expect(text).toContain("commit your changes to the branch feat-foo when done.");
			// Acceptance criteria.
			expect(text).toContain("1. All tests pass");
			expect(text).toContain("2. README updated");
			expect(text).toContain("When done, your final message MUST end with a block:");
			expect(text).toContain("SUMMARY: <one paragraph>");
			expect(text).toContain("SELF_REPORT: pass|fail");
			expect(text).toContain("CHILDREN: <optional lines: id agent outcome summary>");
			// Verification.
			expect(text).toContain("After completing the work, the delegator will run:");
			expect(text).toContain("bun test");
			expect(text).toContain("Ensure your work satisfies it before finishing.");
			// Reporting: outbox echo template uses the actual outbox path.
			expect(text).toContain("After each completed step, append a progress line");
			expect(text).toContain(path.join(dir, "bus", "sa_child.out.jsonl"));
			expect(text).toContain('"to": "parent"');
			expect(text).toContain('"kind": "checkpoint"');
			expect(text).toContain("Messages that arrived before you started are in " + inboxPath(dir, "sa_delegator"));
			expect(text).toContain(`group channel ${groupPath(dir, "grp_demo")}`);
			expect(text).toContain(`main via path ${mainInboxPath(dir)}`);
			// Budget and deadline.
			expect(text).toContain("Hard deadline: 120000 ms after start; the delegator will terminate the run on expiry.");
			expect(text).toContain("Advisory budget: USD 1.5.");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("empty or whitespace objective throws", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			expect(() => render(baseSpec({ objective: "   " }), dir)).toThrow();
			expect(() => render(baseSpec({ objective: "" }), dir)).toThrow();
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("atomic or no-spawn specs forbid recursion", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			expect(render(baseSpec({ autonomy: "atomic" }), dir)).toContain(
				"You MUST NOT spawn sub-subagents. Execute the task directly.",
			);
			expect(render(baseSpec({ allowSpawn: false }), dir)).toContain(
				"You MUST NOT spawn sub-subagents. Execute the task directly.",
			);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("read-only tools and allowBash=false remove bash from the whitelist", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			const allowedToolsLine = (text: string): string =>
				text.match(/- Allowed tools: .*/)?.[0] ?? "";
			const readOnlyText = render(baseSpec({ readOnly: true }), dir, {
				profile: profile({ tools: [] }),
			});
			expect(readOnlyText).toContain("- read-only: yes");
			expect(allowedToolsLine(readOnlyText)).toBe(
				"- Allowed tools: read, grep, glob, web_search",
			);
			expect(allowedToolsLine(readOnlyText)).not.toContain("bash");
			const noBash = render(baseSpec({ allowBash: false }), dir, {
				profile: profile({ tools: [] }),
			});
			expect(allowedToolsLine(noBash)).not.toContain("bash");
			// Profile whitelist wins verbatim.
			const whitelisted = render(baseSpec(), dir, { profile: profile({ tools: ["read", "grep"] }) });
			expect(whitelisted).toContain("- Allowed tools: read, grep");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("no verify, no acceptance, no worktree fall back to the mandated lines", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			const text = render(
				baseSpec({ verify: undefined, acceptance: undefined, worktree: false, timeoutMs: undefined, maxCostUsd: undefined }),
				dir,
			);
			expect(text).toContain(
				"No automated verification command is configured; rely on the acceptance criteria.",
			);
			expect(text).toContain("None beyond the objective.");
			expect(text).not.toContain("isolated git worktree");
			expect(text).toContain("No explicit budget.");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("report cadence variants render their policies", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			expect(render(baseSpec({ reportCadence: "none" }), dir)).toContain(
				"No progress reports required.",
			);
			expect(render(baseSpec({ reportCadence: "turn" }), dir)).toContain(
				"Report after every turn of work.",
			);
			// Undefined cadence defaults to on-checkpoint.
			expect(render(baseSpec({ reportCadence: undefined }), dir)).toContain(
				"After each completed step, append a progress line",
			);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("args maxCostUsd wins over spec.maxCostUsd", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			const text = render(baseSpec(), dir, { maxCostUsd: 9.99 });
			expect(text).toContain("Advisory budget: USD 9.99.");
			expect(text).not.toContain("Advisory budget: USD 1.5.");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("writeContractFile", () => {
	test("writes into <dataDir>/tmp, returns the absolute path, overwrites", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			const p = await writeContractFile(dir, "sa_child", "v1");
			expect(path.isAbsolute(p)).toBe(true);
			expect(p).toBe(path.join(dir, "tmp", "contract-sa_child.md"));
			expect(await fs.promises.readFile(p, "utf8")).toBe("v1");
			await writeContractFile(dir, "sa_child", "v2");
			expect(await fs.promises.readFile(p, "utf8")).toBe("v2");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("runVerify", () => {
	test("succeeds with exitCode 0 and captured output", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			const r = await runVerify("echo ok", dir);
			expect(r.exitCode).toBe(0);
			expect(r.output).toContain("ok");
			expect(r.command).toBe("echo ok");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("fails with the nonzero exit code", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			const r = await runVerify("exit 3", dir);
			expect(r.exitCode).toBe(3);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("timeout reports exitCode -1 with a [timeout] note", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			const r = await runVerify("sleep 5", dir, 50);
			expect(r.exitCode).toBe(-1);
			expect(r.output).toContain("[timeout]");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("never rejects: unknown failures map to exitCode 1", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-contract-"));
		try {
			const r = await runVerify("false", dir);
			expect(r.exitCode).toBe(1);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
