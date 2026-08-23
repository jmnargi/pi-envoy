/**
 * src/spawn.ts — background child `pi` process runner (§4.4 adaptive
 * execution, §4.7 privilege attenuation).
 *
 * Children run `pi --mode json -p --no-session` so their transcript arrives
 * as newline-delimited JSON events on stdout; each parsed event is forwarded
 * through `onMessage` and `wait()` resolves when the process exits. Tool
 * exposure is attenuated with whitelists (read-only / explicit tool list /
 * recursion-only) exactly per §4.7.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { buildChildEnv } from "./config.ts";
import { ENVOY_TOOLS, type ParentContext, type TaskSpec } from "./types.ts";

/** Read-only toolset (§4.7); such children can never recurse. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "glob"];

/** stderr accumulation cap per child (with a truncation marker). */
const STDERR_CAP = 64 * 1024;

interface WaitResult {
	exitCode: number | null;
	stderr: string;
}

export interface SpawnedChild {
	id: string;
	wait(): Promise<WaitResult>;
	kill(reason: string): void;
	pid: number | null;
}

/**
 * Build the pi CLI argv for a child run: JSON-lines mode, no session, plus
 * model/thinking, tool controls, context inheritance, the contract file and
 * the objective text. Returns the argv array without the executable.
 */
export function buildPiArgs(args: { spec: TaskSpec; contractFile: string; taskText: string; systemPrompt?: string }): string[] {
	const { spec, contractFile, taskText, systemPrompt } = args;
	const argv = ["--mode", "json", "-p", "--no-session"];

	if (spec.model) {
		argv.push("--model", spec.model);
	} else if (spec.thinking) {
		argv.push("--thinking", spec.thinking);
	}

	// Tool controls — only one applies, first match wins (§4.7).
	let whitelist: string[] | null = null;
	if (spec.readOnly) {
		whitelist = READ_ONLY_TOOLS;
	} else if (spec.tools && spec.tools.length > 0) {
		whitelist = [...spec.tools, ...(spec.allowSpawn ? [...ENVOY_TOOLS] : [])];
	} else if (spec.allowSpawn === true) {
		whitelist = [...ENVOY_TOOLS];
	}
	if (whitelist) {
		argv.push("--tools", whitelist.join(","));
	} else if (spec.allowBash === false) {
		argv.push("--exclude-tools", "bash");
	}

	if (spec.inheritContext === false) {
		argv.push("--no-context-files");
	}

	// Contract first, then the profile's role/behavior prompt.
	argv.push("--append-system-prompt", contractFile, taskText);
	if (systemPrompt) argv.push("--append-system-prompt", systemPrompt);
	return argv;
}

/**
 * Resolve the executable that runs `pi`: when this module runs inside a real
 * pi process (script arg present, on disk, not a Bun bundle), re-invoke that
 * same runtime+script so the child inherits the pi entry point; otherwise
 * fall back to a `pi` binary on PATH.
 */
function getPiInvocation(piArgs: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...piArgs] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args: piArgs };
	}

	return { command: "pi", args: piArgs };
}

/**
 * Spawn a background child `pi` process. The returned handle's `wait()`
 * resolves once with `{ exitCode, stderr }` when the process exits (the
 * promise is shared, so later calls return the cached result); `kill(reason)`
 * terminates it (SIGTERM, then SIGKILL after a 5s grace). `onMessage`
 * receives parsed JSON-lines events; `onExit` fires on settle.
 */
export function spawnChild(args: {
	id: string;
	spec: TaskSpec;
	ctx: ParentContext;
	cwd: string;
	contractFile: string;
	systemPrompt?: string;
	commandOverride?: { command: string; args: string[] };
	onMessage?: (event: unknown) => void;
	onExit?: (code: number | null) => void;
	timeoutMs?: number;
}): SpawnedChild {
	const { id, spec, ctx, cwd, contractFile, systemPrompt, commandOverride, onMessage, onExit, timeoutMs } = args;
	const group = spec.group ?? ctx.group;
	const env: NodeJS.ProcessEnv = { ...process.env, ...buildChildEnv(ctx, id, group) };

	const invocation =
		commandOverride ??
		getPiInvocation(buildPiArgs({ spec, contractFile, taskText: `Task: ${spec.objective}`, systemPrompt }));

	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		env,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let buffer = "";
	let processStderr = "";
	let stderrTruncated = false;
	let killReason: string | null = null;
	let closed = false;
	let settled: WaitResult | null = null;
	let killTimer: NodeJS.Timeout | null = null;
	let forceTimer: NodeJS.Timeout | null = null;

	let resolveWait: (result: WaitResult) => void = () => {};
	const waitPromise = new Promise<WaitResult>((resolve) => {
		resolveWait = resolve;
	});

	const settle = (exitCode: number | null): void => {
		if (settled) return;
		closed = true;
		settled = { exitCode, stderr: processStderr };
		if (killTimer) clearTimeout(killTimer);
		if (forceTimer) clearTimeout(forceTimer);
		onExit?.(exitCode);
		resolveWait(settled);
	};

	/**
	 * Terminate the child (SIGTERM, then SIGKILL after 5s). Idempotent: the
	 * first caller's reason wins and later calls are no-ops.
	 */
	const kill = (reason: string): void => {
		if (killReason !== null) return;
		killReason = reason;
		if (closed) return;
		try {
			proc.kill("SIGTERM");
		} catch {
			// process already exited; 'close' will settle
		}
		forceTimer = setTimeout(() => {
			try {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			} catch {
				// already gone
			}
		}, 5000);
	};

	if (timeoutMs !== undefined && timeoutMs > 0) {
		killTimer = setTimeout(() => kill("timeout"), timeoutMs);
	}

	const processLine = (line: string): void => {
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return; // non-JSON line (banner, warnings) — ignored
		}
		onMessage?.(event);
	};

	proc.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	});

	proc.stderr?.on("data", (chunk: Buffer) => {
		if (stderrTruncated) return;
		processStderr += chunk.toString();
		if (processStderr.length > STDERR_CAP) {
			processStderr = processStderr.slice(0, STDERR_CAP);
			processStderr += "\n...[stderr truncated]";
			stderrTruncated = true;
		}
	});

	proc.on("close", (code: number | null) => {
		if (buffer.trim()) processLine(buffer);
		settle(code);
	});

	proc.on("error", (err: Error) => {
		processStderr += err.message;
		settle(null);
	});

	/** Resolves once on process close; the shared promise is the cached result. */
	const wait = (): Promise<WaitResult> => waitPromise;

	return { id, wait, kill, pid: proc.pid ?? null };
}
