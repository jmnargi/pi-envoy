/**
 * Poll-cost microbenchmark for the envoy inbox watcher.
 *
 * Measures readNewInbox (incremental, offset-based) against the previous
 * whole-file readFileSync implementation at increasing inbox sizes, in the
 * steady-state cursor-at-EOF position that dominates real polling (no new
 * messages). Also reports the implied per-day cost at the shipping 750 ms
 * cadence (115 200 polls/day/process).
 *
 * Run: bun run bench/poll.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readNewInbox } from "../src/interject.ts";

/** The pre-optimization implementation, for comparison. */
function readNewInboxLegacy(file: string, cursor: number): { messages: unknown[]; nextCursor: number } {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return { messages: [], nextCursor: 0 };
	}
	const lines = raw.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const total = lines.length;
	if (total <= cursor) return { messages: [], nextCursor: cursor };
	const messages: unknown[] = [];
	for (const line of lines.slice(cursor)) {
		if (line.trim() === "") continue;
		try {
			messages.push(JSON.parse(line) as unknown);
		} catch {
			// corrupt line — skip
		}
	}
	return { messages, nextCursor: total };
}

function ns(): bigint {
	return process.hrtime.bigint();
}

function measure(fn: () => void, iters: number): number {
	for (let i = 0; i < 50; i++) fn(); // warmup
	const start = ns();
	for (let i = 0; i < iters; i++) fn();
	return Number(ns() - start) / iters;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envoy-bench-"));
const POLLS_PER_DAY = Math.round((24 * 60 * 60 * 1000) / 750);
const SIZES = [0, 1, 10, 100, 1000, 5000];
const ITERS = 2000;

const line = (i: number): string =>
	JSON.stringify({
		ts: 1700000000000 + i,
		from: "sa_parent",
		to: "sa_child",
		kind: "steer",
		text: `message ${i} with a normal-sized steering payload`,
	}) + "\n";

console.log(`inbox lines | incremental | legacy whole-file | incremental per day (${POLLS_PER_DAY} polls)`);
console.log("-".repeat(90));

for (const n of SIZES) {
	const file = path.join(dir, `in-${n}.jsonl`);
	let content = "";
	for (let i = 0; i < n; i++) content += line(i);
	fs.writeFileSync(file, content);

	// steady state: cursor at EOF (nothing new arrived)
	const cursor = Buffer.byteLength(content);
	const inc = measure(() => readNewInbox(file, cursor), ITERS);
	const leg = measure(() => readNewInboxLegacy(file, cursor), ITERS);
	console.log(
		`${String(n).padEnd(12)} ${inc.toFixed(1).padStart(9)} ns/op  ${leg.toFixed(1).padStart(9)} ns/op   ${((inc * POLLS_PER_DAY) / 1e6).toFixed(2).padStart(8)} ms/day`,
	);
}

fs.rmSync(dir, { recursive: true, force: true });
