/**
 * Tests for the reputation ledger (§4.6/§4.8): append-only writes, reputation
 * aggregation (including even-count median = mean of the two middle values)
 * and newest-first listing.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendOutcome, ledgerPath, listLedger, reputation, type LedgerEntry } from "../src/ledger.ts";
import type { Attestation, Usage } from "../src/types.ts";

function attestation(
	taskId: string,
	agent: string,
	outcome: Attestation["outcome"],
	verify?: Attestation["verify"],
): Attestation {
	return {
		taskId,
		agent,
		outcome,
		verify: verify ?? null,
		acceptance: outcome === "verified" || outcome === "unverified",
		children: [],
		summary: `summary for ${taskId}`,
	};
}

function usage(cost: number, durationMs: number): Usage {
	return {
		input: 100,
		output: 200,
		cacheRead: 0,
		cacheWrite: 0,
		cost,
		contextTokens: 300,
		turns: 2,
		durationMs,
	};
}

describe("ledger", () => {
	test("appendOutcome writes a JSON line with the audit fields", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-ledger-"));
		try {
			const att = attestation("t1", "sa_worker", "verified", {
				command: "bun test",
				exitCode: 0,
				output: "all green",
			});
			await appendOutcome(dir, att, usage(0.5, 123));
			expect(ledgerPath(dir)).toBe(path.join(dir, "ledger.jsonl"));
			const raw = await fs.promises.readFile(ledgerPath(dir), "utf8");
			const entry = JSON.parse(raw.trim()) as LedgerEntry;
			expect(entry.taskId).toBe("t1");
			expect(entry.agent).toBe("sa_worker");
			expect(entry.outcome).toBe("verified");
			expect(entry.verify).toEqual({ command: "bun test", exitCode: 0 });
			expect(entry.summary).toBe("summary for t1");
			expect(entry.costUsd).toBe(0.5);
			expect(entry.durationMs).toBe(123);
			expect(entry.turns).toBe(2);
			expect(entry.input).toBe(100);
			expect(entry.output).toBe(200);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("aggregates reputation: successRate, even-count median, cost, lastOutcome", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-ledger-"));
		try {
			await appendOutcome(dir, attestation("t1", "sa_worker", "verified"), usage(0.01, 100));
			await appendOutcome(dir, attestation("t2", "sa_worker", "unverified"), usage(0.02, 200));
			await appendOutcome(dir, attestation("t3", "sa_worker", "failed"), usage(0.03, 300));

			const reps = await reputation(dir, "sa_worker");
			expect(reps).toHaveLength(1);
			const rep = reps[0]!;
			expect(rep.agent).toBe("sa_worker");
			expect(rep.runs).toBe(3);
			expect(rep.successes).toBe(2); // verified + unverified
			expect(rep.failures).toBe(1); // failed
			expect(rep.successRate).toBeCloseTo(2 / 3, 6);
			// Odd count (3 runs): median = middle value of 100/200/300.
			expect(rep.medianDurationMs).toBe(200);
			expect(rep.totalCostUsd).toBeCloseTo(0.06, 6);
			// lastOutcome follows file order: whatever was appended last.
			expect(rep.lastOutcome).toBe("failed");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("even-count median averages the middle two; odd-count takes the middle", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-ledger-"));
		try {
			await appendOutcome(dir, attestation("t1", "sa_worker", "verified"), usage(0, 50));
			await appendOutcome(dir, attestation("t2", "sa_worker", "verified"), usage(0, 10));
			await appendOutcome(dir, attestation("t3", "sa_worker", "verified"), usage(0, 40));
			expect((await reputation(dir, "sa_worker"))[0]!.medianDurationMs).toBe(40); // sorted [10,40,50]
			await appendOutcome(dir, attestation("t4", "sa_worker", "verified"), usage(0, 100));
			expect((await reputation(dir, "sa_worker"))[0]!.medianDurationMs).toBe(45); // mean of 40 and 50
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("agent filter: absent agent yields [], all-agent mode lists every present agent", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-ledger-"));
		try {
			await appendOutcome(dir, attestation("t1", "sa_worker", "verified"), usage(0.1, 100));
			expect(await reputation(dir, "sa_other")).toEqual([]);
			const all = await reputation(dir);
			expect(all).toHaveLength(1);
			expect(all[0]!.agent).toBe("sa_worker");
			await appendOutcome(dir, attestation("t2", "sa_scout", "timeout"), usage(0.2, 50));
			const all2 = await reputation(dir);
			expect(all2.map((r) => r.agent).sort()).toEqual(["sa_scout", "sa_worker"]);
			const scout = (await reputation(dir, "sa_scout"))[0]!;
			expect(scout.successes).toBe(0);
			expect(scout.failures).toBe(1);
			expect(scout.lastOutcome).toBe("timeout");
			expect(scout.medianDurationMs).toBe(50);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("empty ledger yields []", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-ledger-"));
		try {
			expect(await reputation(dir)).toEqual([]);
			expect(await reputation(dir, "sa_worker")).toEqual([]);
			expect(await listLedger(dir)).toEqual([]);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("listLedger returns entries newest first (ts ties break toward later appends)", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-ledger-"));
		try {
			// Entries may share a ts (Date.now); ordering stays deterministic:
			// listLedger breaks ts ties toward the later-appended entry.
			await appendOutcome(dir, attestation("t1", "sa_worker", "verified"), usage(0, 10));
			await appendOutcome(dir, attestation("t2", "sa_worker", "failed"), usage(0, 20));
			await appendOutcome(dir, attestation("t3", "sa_worker", "cancelled"), usage(0, 30));
			const entries = (await listLedger(dir)) as LedgerEntry[];
			expect(entries.map((e) => e.taskId)).toEqual(["t3", "t2", "t1"]);
			expect(entries[0]!.outcome).toBe("cancelled");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("corrupt ledger lines are skipped without breaking aggregation", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-ledger-"));
		try {
			await appendOutcome(dir, attestation("t1", "sa_worker", "verified"), usage(0, 10));
			await fs.promises.appendFile(ledgerPath(dir), "garbage line\n", "utf8");
			await appendOutcome(dir, attestation("t2", "sa_worker", "failed"), usage(0, 20));
			const rep = (await reputation(dir, "sa_worker"))[0]!;
			expect(rep.runs).toBe(2);
			expect(rep.successes).toBe(1);
			const entries = (await listLedger(dir)) as LedgerEntry[];
			expect(entries.map((e) => e.taskId)).toEqual(["t2", "t1"]);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
