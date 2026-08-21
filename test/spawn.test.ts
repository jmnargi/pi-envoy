/**
 * test/spawn.test.ts — hermetic coverage for src/spawn.ts using a fake `pi`
 * fixture (a small node script that emits JSON-lines events and exits with a
 * caller-chosen status) so tests never need a real pi install.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setDataDirForTests } from "../src/config.ts";
import { buildPiArgs, spawnChild } from "../src/spawn.ts";
import { ENVOY_TOOLS, type ParentContext, type ThinkingLevel } from "../src/types.ts";

const suiteRoot = mkdtempSync(join(tmpdir(), "pi-envoy-spawn-"));
const fakePi = join(suiteRoot, "fake-pi.mjs");
const readyMarker = join(suiteRoot, "child-ready.marker");

// Fake pi child: emits two JSON-lines events, dumps PI_ENVOY_* env vars to
// a sibling file, then exits with the status in argv[2] (default 0). With
// --sleep it emits nothing and runs for 30s (killed by the runner); it writes
// a ready marker before sleeping so tests can await the child's booted state.
// With --graceful it exits 0 on SIGTERM (cancel test) instead of dying by
// signal (timeout test).
writeFileSync(
	fakePi,
	`import { writeFileSync } from "node:fs";

const graceful = process.argv.includes("--graceful");
if (graceful) {
	process.on("SIGTERM", () => process.exit(0));
}

const sleep = process.argv.includes("--sleep");
if (sleep) {
	writeFileSync(new URL("./child-ready.marker", import.meta.url), "1");
	setTimeout(() => process.exit(0), 30_000);
} else {
	const envDump = {};
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_ENVOY_")) envDump[key] = process.env[key];
	}
	writeFileSync(new URL("./child-env.json", import.meta.url), JSON.stringify(envDump));

	const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, totalTokens: 15 },
			stopReason: "stop",
			model: "fake",
		},
	});
	emit({ type: "tool_result_end", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } });

	const code = Number.parseInt(process.argv[2] ?? "0", 10);
	process.exitCode = Number.isNaN(code) ? 0 : code;
}
`,
);

const contractFile = join(suiteRoot, "contract.md");
const specBase = { agent: "worker", objective: "do a thing" };

/**
 * Wait until the child process has booted (its SIGTERM handler registered
 * and ready marker written). The child is a real separate OS process whose
 * boot is not observable via promise/event APIs, so this polls the marker
 * the fixture writes only after its handlers are set up — the actual
 * condition, not a fixed-duration guess. Callers remove the marker before
 * spawning so this tracks the current child.
 */
async function waitForReady(timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(readyMarker)) {
		if (Date.now() > deadline) throw new Error("fake pi child did not become ready in time");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

beforeAll(() => {
	setDataDirForTests(suiteRoot);
});

afterAll(() => {
	rmSync(suiteRoot, { recursive: true, force: true });
});

describe("buildPiArgs", () => {
	test("always uses JSON-lines mode, no session, and appends contract + task text", () => {
		const argv = buildPiArgs({ spec: specBase, contractFile, taskText: "Task: do a thing" });
		expect(argv.slice(0, 3)).toEqual(["--mode", "json", "-p"]);
		expect(argv).toContain("--no-session");
		expect(argv).toContain("--append-system-prompt");
		expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe(contractFile);
		expect(argv[argv.length - 1]).toBe("Task: do a thing");
	});

	test("readOnly drops to the minimal read-only toolset", () => {
		const argv = buildPiArgs({ spec: { ...specBase, readOnly: true }, contractFile, taskText: "t" });
		expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,find,ls,glob");
		expect(argv).not.toContain("--exclude-tools");
	});

	test("explicit tools become a whitelist; allowSpawn appends ENVOY_TOOLS", () => {
		const argv = buildPiArgs({ spec: { ...specBase, tools: ["read", "edit"], allowSpawn: true }, contractFile, taskText: "t" });
		expect(argv[argv.indexOf("--tools") + 1]).toBe(["read", "edit", ...ENVOY_TOOLS].join(","));
		const argvNoSpawn = buildPiArgs({ spec: { ...specBase, tools: ["read"] }, contractFile, taskText: "t" });
		expect(argvNoSpawn[argvNoSpawn.indexOf("--tools") + 1]).toBe("read");
	});

	test("allowSpawn alone whitelists recursion tools; allowBash false excludes bash only without a whitelist", () => {
		const argv = buildPiArgs({ spec: { ...specBase, allowSpawn: true }, contractFile, taskText: "t" });
		expect(argv[argv.indexOf("--tools") + 1]).toBe(ENVOY_TOOLS.join(","));
		const argvNoBash = buildPiArgs({ spec: { ...specBase, allowBash: false }, contractFile, taskText: "t" });
		expect(argvNoBash[argvNoBash.indexOf("--exclude-tools") + 1]).toBe("bash");
		expect(argvNoBash).not.toContain("--tools");
	});

	test("model wins over thinking; inheritContext false drops context files", () => {
		const argvModel = buildPiArgs({ spec: { ...specBase, model: "gpt-x", thinking: "low" as ThinkingLevel }, contractFile, taskText: "t" });
		expect(argvModel[argvModel.indexOf("--model") + 1]).toBe("gpt-x");
		expect(argvModel).not.toContain("--thinking");
		const argvThinking = buildPiArgs({ spec: { ...specBase, thinking: "high" as ThinkingLevel }, contractFile, taskText: "t" });
		expect(argvThinking[argvThinking.indexOf("--thinking") + 1]).toBe("high");
		const argvNoCtx = buildPiArgs({ spec: { ...specBase, inheritContext: false }, contractFile, taskText: "t" });
		expect(argvNoCtx).toContain("--no-context-files");
	});
});

describe("spawnChild", () => {
	const runDir = mkdtempSync(join(suiteRoot, "run-"));
	const parentCtx: ParentContext = {
		id: "sa_parent",
		parentId: null,
		group: "g",
		depth: 0,
		dataDir: runDir,
		inbox: join(runDir, "inbox"),
		mainInbox: join(runDir, "main-inbox"),
		maxDepth: 4,
	};

	// Complete spawnChild args with per-test overrides. Required fields are
	// merged via `??` so every key stays required; optional fields are passed
	// through (explicit undefined is fine without exactOptionalPropertyTypes).
	const spawnArgs = (
		over: Partial<Parameters<typeof spawnChild>[0]> = {},
	): Parameters<typeof spawnChild>[0] => ({
		id: over.id ?? "sa_child",
		spec: over.spec ?? specBase,
		ctx: over.ctx ?? parentCtx,
		cwd: over.cwd ?? runDir,
		contractFile: over.contractFile ?? contractFile,
		commandOverride: over.commandOverride,
		onMessage: over.onMessage,
		onExit: over.onExit,
		timeoutMs: over.timeoutMs,
	});

	test("forwards parsed JSON events and wires the child env", async () => {
		const events: unknown[] = [];
		const runner = spawnChild(
			spawnArgs({
				id: "sa_child_1",
				commandOverride: { command: process.execPath, args: [fakePi, "0"] },
				onMessage: (ev) => events.push(ev),
			}),
		);
		expect(typeof runner.pid).toBe("number");

		const res = await runner.wait();
		expect(res.exitCode).toBe(0);
		expect(res.stderr).toBe("");

		expect(events).toHaveLength(2);
		const first = events[0] as Record<string, unknown> | undefined;
		expect(first?.type).toBe("message_end");
		const content = (first?.message as Record<string, unknown> | undefined)?.content as
			| Array<Record<string, unknown>>
			| undefined;
		expect(content?.[0]?.text).toBe("hello");

		const envDump = JSON.parse(readFileSync(join(suiteRoot, "child-env.json"), "utf8")) as Record<string, string>;
		expect(envDump.PI_ENVOY_ID).toBe("sa_child_1");
		expect(envDump.PI_ENVOY_DEPTH).toBe("1"); // ctx.depth + 1
		expect(envDump.PI_ENVOY_GROUP).toBe("g");
	});

	test("surfaces a nonzero child exit code", async () => {
		const runner = spawnChild(spawnArgs({ commandOverride: { command: process.execPath, args: [fakePi, "3"] } }));
		const res = await runner.wait();
		expect(res.exitCode).toBe(3);
	});

	test("kills a child that exceeds the timeout", async () => {
		// Integration test: exercises the runner's real deadline timer against a
		// real sleeping child process — deterministic fake-clock control cannot
		// drive a separate OS process.
		const start = Date.now();
		const runner = spawnChild(
			spawnArgs({
				id: "sa_timeout",
				commandOverride: { command: process.execPath, args: [fakePi, "--sleep"] },
				timeoutMs: 300,
			}),
		);
		const res = await runner.wait();
		const elapsed = Date.now() - start;
		expect(res.exitCode).toBeNull();
		expect(elapsed).toBeLessThan(10_000);
	});

	test("kill() cancels a running child", async () => {
		const start = Date.now();
		rmSync(readyMarker, { force: true }); // track this child's marker specifically
		const runner = spawnChild(
			spawnArgs({
				id: "sa_cancel",
				commandOverride: { command: process.execPath, args: [fakePi, "--sleep", "--graceful"] },
			}),
		);
		await waitForReady(); // child booted → SIGTERM handler is registered
		runner.kill("cancelled");
		runner.kill("cancelled"); // idempotent — must not throw
		const res = await runner.wait();
		const elapsed = Date.now() - start;
		expect(res.exitCode).toBe(0);
		expect(elapsed).toBeLessThan(5_000);
	});
});
