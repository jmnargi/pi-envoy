/**
 * Delegation contract (§4.1 contract-first decomposition, §4.2 roles &
 * boundaries, §4.8 verifiable completion).
 *
 * The contract is a markdown document the delegatee reads at spawn time: it
 * pins the objective, boundaries, acceptance criteria, verification command,
 * reporting cadence and budget so both sides share one unforgeable spec.
 */

import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProfile, ParentContext, TaskSpec, VerifyResult } from "./types.ts";

/** Core toolset offered to children unless the profile whitelists tools. */
const DEFAULT_TOOLS = ["read", "write", "edit", "grep", "glob", "bash", "eval", "hub", "task"];

/** The read-only toolset used under `readOnly` (§4.7 privilege attenuation). */
const READ_ONLY_TOOLS = ["read", "grep", "glob", "web_search"];

/**
 * Effective tool list from `profile.tools` (whitelist wins), else the default
 * set reduced by `readOnly` / `allowBash: false`. [INFERENCE] The precise
 * resolution lives in src/index.ts wiring; contract rendering shows the
 * profile/flag-derived list, with subagent recursion covered by the policy.
 */
function effectiveTools(spec: TaskSpec, profile: AgentProfile): string[] {
	if (profile.tools && profile.tools.length > 0) return [...profile.tools];
	const base = spec.readOnly ? READ_ONLY_TOOLS : DEFAULT_TOOLS;
	if (spec.allowBash === false) return base.filter((t) => t !== "bash");
	return [...base];
}

/**
 * §4.2/§4.5 reporting policy text for the given cadence.
 */
function reportingPolicy(spec: TaskSpec, outbox: string): string {
	const cadence = spec.reportCadence ?? "on-checkpoint";
	switch (cadence) {
		case "none":
			return "No progress reports required.";
		case "turn":
			return "Report after every turn of work.";
		default:
			return (
				"After each completed step, append a progress line to the OUTBOX file (shown below) " +
				"using bash, e.g. `echo '{\"ts\": <epoch-ms>, \"from\": \"" +
				"<id>\", \"to\": \"parent\", \"kind\": \"checkpoint\", \"text\": \"<brief note>\"}' >> " +
				outbox +
				"` — single-quoted JSON with escaped quotes; keep notes under 400 chars."
			);
	}
}

// The tsconfig `lib` targets ES2022 and the installed @types/node does not
// yet declare `Promise.withResolvers`, so declare the missing member locally
// (present in Node ≥20 and Bun at runtime).
declare global {
	interface PromiseConstructor {
		withResolvers<T>(): {
			promise: Promise<T>;
			resolve: (value: T | PromiseLike<T>) => void;
			reject: (reason?: unknown) => void;
		};
	}
}

/**
 * Render the full "Delegation Contract" markdown (§4.1/§4.2/§4.8). Throws
 * when the objective is empty or whitespace. Section order is fixed and every
 * section is present.
 */
export function buildContractText(args: {
	spec: TaskSpec;
	profile: AgentProfile;
	ctx: ParentContext;
	inbox: string;
	outbox: string;
	groupChannel: string;
	childId: string;
	maxCostUsd?: number;
}): string {
	const { spec, profile, ctx, inbox, outbox, groupChannel, childId } = args;
	if (spec.objective.trim().length === 0) {
		throw new Error("contract objective must not be empty");
	}

	// -- identity -----------------------------------------------------------
	const identity = [
		"# Delegation Contract",
		"",
		`Task ID: ${childId}`,
		`Role: ${profile.name}`,
		`Delegator: ${ctx.id ?? "main"}`,
	].join("\n");

	// -- §4.2 scope and boundaries ------------------------------------------
	const scope: string[] = [
		`- Working directory: ${spec.cwd ?? process.cwd()}`,
		`- Allowed tools: ${effectiveTools(spec, profile).join(", ")}`,
		`- read-only: ${spec.readOnly ? "yes" : "no"}`,
		spec.allowSpawn && spec.autonomy !== "atomic"
			? "- You MAY delegate sub-tasks to sub-subagents using the subagent_* tools. Never exceed the maximum depth; you are responsible for verifying their work and reporting them transitively (§4.8)."
			: "- You MUST NOT spawn sub-subagents. Execute the task directly.",
	];
	if (spec.worktree) {
		// [INFERENCE] worktrees.ts derives the branch as `subagent/<id>` when
		// the spec does not name one (see the createWorktree contract note).
		const branch = spec.branch ?? `subagent/${childId}`;
		scope.push(
			`- You operate in an isolated git worktree; commit your changes to the branch ${branch} when done.`,
		);
	}

	// -- §4.1 acceptance criteria ------------------------------------------
	const acceptance: string[] = [];
	if (spec.acceptance && spec.acceptance.length > 0) {
		spec.acceptance.forEach((criterion, i) => acceptance.push(`${i + 1}. ${criterion}`));
	} else {
		acceptance.push("None beyond the objective.");
	}
	acceptance.push(
		"",
		"When done, your final message MUST end with a block:",
		"",
		"```",
		"SUMMARY: <one paragraph>",
		"SELF_REPORT: pass|fail",
		"CHILDREN: <optional lines: id agent outcome summary>",
		"```",
	);

	// -- §4.8 verification --------------------------------------------------
	const verification = spec.verify
		? [
				"After completing the work, the delegator will run:",
				"",
				"```",
				spec.verify,
				"```",
				"",
				"Ensure your work satisfies it before finishing.",
			]
		: ["No automated verification command is configured; rely on the acceptance criteria."];

	// -- §4.5 reporting ------------------------------------------------------
	const reporting = [
		reportingPolicy(spec, outbox),
		"",
		`At the start of each work step, read your INBOX file ${inbox} (if it exists) and treat any lines as instructions from the delegator; prioritize them.`,
		"",
		`You may post messages to the group channel ${groupChannel} for siblings, and to main via path ${ctx.mainInbox}.`,
	];

	// -- §4.3 budget and deadline -------------------------------------------
	const budget: string[] = [];
	if (spec.timeoutMs) {
		budget.push(
			`Hard deadline: ${spec.timeoutMs} ms after start; the delegator will terminate the run on expiry.`,
		);
	}
	const budgetUsd = args.maxCostUsd ?? spec.maxCostUsd;
	if (budgetUsd !== undefined) {
		budget.push(`Advisory budget: USD ${budgetUsd}.`);
	}
	if (budget.length === 0) budget.push("No explicit budget.");

	const sections = [
		identity,
		`## Objective\n\n${spec.objective}`,
		`## Scope and boundaries\n\n${scope.join("\n")}`,
		`## Acceptance criteria\n\n${acceptance.join("\n")}`,
		`## Verification\n\n${verification.join("\n")}`,
		`## Reporting\n\n${reporting.join("\n")}`,
		`## Budget and deadline\n\n${budget.join("\n")}`,
		"— end of contract —",
	];
	return sections.join("\n\n") + "\n";
}

/**
 * Write the rendered contract to `<dataDir>/tmp/contract-<childId>.md`,
 * creating `<dataDir>/tmp` as needed. Overwrites any existing file and
 * returns the absolute path (the caller deletes it after the run).
 */
export async function writeContractFile(
	dataDir: string,
	childId: string,
	text: string,
): Promise<string> {
	const outDir = path.join(dataDir, "tmp");
	const file = path.resolve(outDir, `contract-${childId}.md`);
	await fs.promises.mkdir(outDir, { recursive: true });
	await fs.promises.writeFile(file, text, "utf8");
	return file;
}

/**
 * Run a single verification command via `sh -c` (§4.8). Never throws: a
 * nonzero exit, signal or timeout is returned as a VerifyResult. Output
 * (stdout+stderr) is capped at 20 000 chars; timeouts report exitCode -1
 * with a "[timeout]" note in the output.
 */
export function runVerify(command: string, cwd: string, timeoutMs = 60_000): Promise<VerifyResult> {
	return new Promise<VerifyResult>((resolve) => {
		exec(
			command,
			{
				cwd,
				timeout: timeoutMs,
				// Node accepts `true` (platform default shell); @types/node@22
				// types this option as string, so cast to keep the runtime value.
				shell: true as unknown as string,
				maxBuffer: 64 * 1024,
			},
			(error, stdout, stderr) => {
				const captured = [stdout, stderr]
					.filter((s) => s.length > 0)
					.join("\n")
					.slice(0, 20_000);
				if (!error) {
					resolve({ command, exitCode: 0, output: captured });
					return;
				}
				// Timeouts/signals first so a runtime that reports a numeric code
				// alongside `killed` still maps to the mandated -1 + "[timeout]".
				let exitCode: number | null;
				let note = "";
				if (error.killed || error.signal != null) {
					exitCode = -1;
					note = "[timeout]";
				} else if (typeof error.code === "number") {
					exitCode = error.code;
				} else {
					exitCode = 1;
				}
				const output = note ? (captured ? `${captured}\n${note}` : note) : captured;
				resolve({ command, exitCode, output });
			},
		);
	});
}
