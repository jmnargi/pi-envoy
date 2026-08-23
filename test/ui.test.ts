/**
 * Unit tests for the pure dashboard/formatting helpers (src/ui.ts).
 */

import { describe, expect, test } from "bun:test";

import {
	dashboardData,
	fmtAge,
	fmtCost,
	fmtModel,
	fmtShortId,
	fmtThinking,
	fmtTokens,
	killLabel,
	stateToken,
	truncate,
	type DashboardRow,
	type EntryView,
} from "../src/ui.ts";
import { compactRowLabel } from "../src/dashboard.ts";

const viewDefaultUsage = { cost: 0, durationMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };

const view = (over: Partial<EntryView>): EntryView => ({
	id: "sa_2fc7ac2e5893",
	name: "worker",
	agent: "worker",
	state: "running",
	queuedAt: 1000,
	startedAt: 2000,
	endedAt: 0,
	usage: { ...viewDefaultUsage },
	summary: "",
	outcome: null,
	...over,
});

describe("fmtShortId", () => {
	test("strips the sa_ prefix and shortens", () => {
		expect(fmtShortId("sa_2fc7ac2e5893")).toBe("2fc7ac2e");
	});
	test("handles non-sa ids", () => {
		expect(fmtShortId("main")).toBe("main");
	});
});

describe("fmtAge", () => {
	test("seconds, minutes, hours", () => {
		expect(fmtAge(42_000)).toBe("42s");
		expect(fmtAge(192_000)).toBe("3m12s");
		expect(fmtAge(7_200_000)).toBe("2h0m");
	});
	test("invalid input renders a dash", () => {
		expect(fmtAge(-5)).toBe("—");
	});
});

describe("fmtCost", () => {
	test("zero shows a dash", () => {
		expect(fmtCost(0)).toBe("-");
	});
	test("small amounts keep four decimals", () => {
		expect(fmtCost(0.00123)).toBe("$0.0012");
	});
	test("larger amounts round to three decimals", () => {
		expect(fmtCost(0.012345)).toBe("$0.012");
	});
});

describe("truncate", () => {
	test("short text passes through", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});
	test("long text is clipped with an ellipsis", () => {
		expect(truncate("abcdefghij", 5)).toBe("abcd…");
	});
});

describe("stateToken", () => {
	test("success states map to success", () => {
		expect(stateToken("done")).toBe("success");
		expect(stateToken("verified")).toBe("success");
	});
	test("failure/cancellation map to error/warning", () => {
		expect(stateToken("failed")).toBe("error");
		expect(stateToken("timeout")).toBe("error");
		expect(stateToken("cancelled")).toBe("warning");
	});
	test("in-flight states map to accent", () => {
		expect(stateToken("running")).toBe("accent");
		expect(stateToken("queued")).toBe("accent");
	});
});

describe("killLabel", () => {
	test("maps termination reasons to human labels", () => {
		expect(killLabel("cancelled")).toBe("killed by user");
		expect(killLabel("shutdown")).toBe("killed by shutdown");
		expect(killLabel("timeout")).toBe("timed out");
	});
	test("null/undefined means normal completion", () => {
		expect(killLabel(null)).toBeNull();
		expect(killLabel(undefined)).toBeNull();
	});
});

describe("fmtTokens", () => {
	test("formats raw, thousands, millions", () => {
		expect(fmtTokens(0)).toBe("-");
		expect(fmtTokens(500)).toBe("500");
		expect(fmtTokens(1234)).toBe("1.2k");
		expect(fmtTokens(1_234_567)).toBe("1.2M");
	});
});

describe("fmtThinking", () => {
	test("maps levels to short labels, unset to dash", () => {
		expect(fmtThinking(undefined)).toBe("-");
		expect(fmtThinking("high")).toBe("hi");
		expect(fmtThinking("xhigh")).toBe("xhi");
		expect(fmtThinking("medium")).toBe("med");
		expect(fmtThinking("unknown")).toBe("unknown");
	});
});

describe("fmtModel", () => {
	test("strips common suffixes, unset to dash", () => {
		expect(fmtModel(undefined)).toBe("-");
		expect(fmtModel("gpt-5-code")).toBe("gpt-5");
		expect(fmtModel("claude-sonnet-latest")).toBe("claude-sonnet");
		expect(fmtModel("gemini-pro")).toBe("gemini");
	});
});

describe("compactRowLabel", () => {
	test("renders a fixed-width row with model/thinking/tokens/cost/age", () => {
		const row: DashboardRow = {
			id: "sa_2fc7ac2e5893",
			shortId: "2fc7ac2e",
			name: "api-refactor",
			agent: "worker",
			state: "running",
			ageMs: 42_000,
			cost: 0.0123,
			input: 1234,
			output: 567,
			cacheRead: 0,
			cacheWrite: 0,
			contextTokens: 2048,
			turns: 2,
			model: "gpt-5-code",
			thinking: "high",
			summary: "",
			outcome: null,
		};
		const label = compactRowLabel(row);
		expect(label).toContain("api-refactor");
		expect(label).toContain("gpt-5");
		expect(label).toContain("hi"); // thinking
		expect(label).toMatch(/↑\s*1\.2k/);
		expect(label).toMatch(/↓\s*567/);
		expect(label).toContain("$0.012");
		expect(label).toContain("42s");
	});
});

describe("dashboardData", () => {
	test("partitions running/queued/finished and sums cost", () => {
		const d = dashboardData([
			view({ id: "sa_aaaa1111", state: "running", startedAt: 10_000, usage: { ...viewDefaultUsage, cost: 0.001 } }),
			view({ id: "sa_bbbb2222", state: "queued", queuedAt: 500, startedAt: 0 }),
			view({ id: "sa_cccc3333", state: "done", startedAt: 100, endedAt: 500, outcome: "verified", usage: { ...viewDefaultUsage, cost: 0.004, durationMs: 400 }, summary: "ok", killReason: "cancelled" }),
		]);
		expect(d.totals).toEqual({ running: 1, queued: 1, finished: 1, costUsd: 0.005 });
		expect(d.running[0]?.shortId).toBe("aaaa1111");
		expect(d.running[0]?.ageMs).toBeGreaterThan(0);
		expect(d.queued[0]?.agent).toBe("worker");
		expect(d.finished[0]?.summary).toBe("ok");
		expect(d.finished[0]?.killReason).toBe("cancelled");
	});

	test("finished rows are capped at the limit", () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			view({ id: `sa_f${String(i).padStart(4, "0")}`, state: "done", startedAt: i * 100, endedAt: i * 100 + 50, outcome: "unverified" }),
		);
		const d = dashboardData(many, 5);
		expect(d.finished).toHaveLength(5);
		expect(d.totals.finished).toBe(12);
	});
});
