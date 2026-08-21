/**
 * Reputation ledger (§4.6 trust & reputation; §4.8 verifiable completion).
 *
 * Every finished child run is appended as one immutable JSON line to
 * `<dataDir>/ledger.jsonl`. Reputation aggregates are derived from the ledger
 * rather than stored, so the file stays a pure append-only audit trail.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Attestation, ReputationSummary, Usage } from "./types.ts";

/** One immutable ledger line, as appended by appendOutcome. */
export interface LedgerEntry {
	ts: number;
	taskId: string;
	agent: string;
	outcome: Attestation["outcome"];
	verify: { command: string; exitCode: number | null } | null;
	summary: string;
	costUsd: number;
	durationMs: number;
	turns: number;
	input: number;
	output: number;
}

/** Path of the audit ledger: `<dataDir>/ledger.jsonl`. */
export function ledgerPath(dataDir: string): string {
	return path.join(dataDir, "ledger.jsonl");
}

/**
 * Append one completed run to the ledger (§4.6/§4.8). The entry records the
 * attestation outcome plus the usage accounting; writes are atomic
 * single-line appends after ensuring the parent directory exists.
 */
export async function appendOutcome(
	dataDir: string,
	attestation: Attestation,
	usage: Usage,
): Promise<void> {
	const entry: LedgerEntry = {
		ts: Date.now(),
		taskId: attestation.taskId,
		agent: attestation.agent,
		outcome: attestation.outcome,
		verify: attestation.verify
			? { command: attestation.verify.command, exitCode: attestation.verify.exitCode }
			: null,
		summary: attestation.summary,
		costUsd: usage.cost,
		durationMs: usage.durationMs,
		turns: usage.turns,
		input: usage.input,
		output: usage.output,
	};
	const file = ledgerPath(dataDir);
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await fs.promises.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

async function readEntries(dataDir: string): Promise<LedgerEntry[]> {
	const file = ledgerPath(dataDir);
	let content: string;
	try {
		content = await fs.promises.readFile(file, "utf8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const entries: LedgerEntry[] = [];
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line) as LedgerEntry);
		} catch {
			// Corrupt line — skip silently (audit file stays readable).
		}
	}
	return entries;
}

/**
 * Median of a value list, or null when empty. Even-sized lists use the
 * average of the two middle values (documented convention).
 */
function median(values: number[]): number | null {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	if (n === 0) return null;
	const mid = Math.floor(n / 2);
	if (n % 2 === 1) return sorted[mid]!;
	return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Aggregate reputation (§4.6) for one agent, or for every agent present when
 * `agent` is omitted. Success = outcome in ["verified", "unverified"];
 * failures = "failed" | "cancelled" | "timeout". `lastOutcome` is the outcome
 * of the most recently appended entry. Returns [] when there are no entries
 * (or when the requested agent has no entries at all).
 */
export async function reputation(dataDir: string, agent?: string): Promise<ReputationSummary[]> {
	const entries = await readEntries(dataDir);
	const byAgent = new Map<string, LedgerEntry[]>();
	for (const entry of entries) {
		if (agent !== undefined && entry.agent !== agent) continue;
		const list = byAgent.get(entry.agent);
		if (list) list.push(entry);
		else byAgent.set(entry.agent, [entry]);
	}
	if (byAgent.size === 0) return [];

	const summaries: ReputationSummary[] = [];
	for (const [name, list] of byAgent) {
		const successes = list.filter(
			(e) => e.outcome === "verified" || e.outcome === "unverified",
		).length;
		const failures = list.filter(
			(e) => e.outcome === "failed" || e.outcome === "cancelled" || e.outcome === "timeout",
		).length;
		const durations = list
			.map((e) => e.durationMs)
			.filter((d): d is number => typeof d === "number" && Number.isFinite(d));
		const last = list[list.length - 1]!;
		summaries.push({
			agent: name,
			runs: list.length,
			successes,
			failures,
			successRate: successes / list.length,
			medianDurationMs: median(durations),
			totalCostUsd: list.reduce(
				(sum, e) => sum + (typeof e.costUsd === "number" ? e.costUsd : 0),
				0,
			),
			lastOutcome: last.outcome,
		});
	}
	summaries.sort((a, b) => a.agent.localeCompare(b.agent));
	return summaries;
}

/**
 * All ledger entries, newest first (ties broken toward the later-appended
 * entry). Returned as `unknown[]` per the module contract.
 */
export async function listLedger(dataDir: string): Promise<unknown[]> {
	const entries = await readEntries(dataDir);
	const indexed = entries.map((entry, i) => ({ entry, i }));
	indexed.sort((a, b) => b.entry.ts - a.entry.ts || b.i - a.i);
	return indexed.map((x) => x.entry);
}
