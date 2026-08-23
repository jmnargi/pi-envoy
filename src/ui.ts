/**
 * Pure dashboard/formatting helpers for the envoy live UI.
 * No pi-tui imports here — everything unit-testable without a terminal.
 */

/** Minimal child view consumed by the live dashboard. */
export interface EntryView {
	id: string;
	/** Human-readable name (spec.name); falls back to agent profile name. */
	name: string;
	agent: string;
	state: string;
	queuedAt: number;
	startedAt: number;
	endedAt: number;
	usage: { cost: number; durationMs: number };
	summary: string;
	outcome: string | null;
	/** Who/what terminated the child, if not a normal completion. */
	killReason?: "cancelled" | "shutdown" | "timeout" | null;
}

export interface DashboardRow {
	id: string;
	shortId: string;
	/** Human-readable name shown in the UI. */
	name: string;
	agent: string;
	state: string;
	ageMs: number;
	cost: number;
	summary: string;
	outcome: string | null;
	/** Who/what terminated the child, if not a normal completion. */
	killReason?: "cancelled" | "shutdown" | "timeout" | null;
}

/** Human label for a non-normal termination (shown in the dashboard). */
export function killLabel(reason: "cancelled" | "shutdown" | "timeout" | null | undefined): string | null {
	switch (reason) {
		case "cancelled":
			return "killed by user";
		case "shutdown":
			return "killed by shutdown";
		case "timeout":
			return "timed out";
		default:
			return null;
	}
}

/** Prefer the human name when present, else fall back to the short id. */
export function displayName(e: { name?: string; agent?: string; id: string }): string {
	if (e.name && e.name.trim() !== "") return e.name;
	if (e.agent && e.agent.trim() !== "") return e.agent;
	return fmtShortId(e.id);
}

export interface Dashboard {
	running: DashboardRow[];
	queued: DashboardRow[];
	finished: DashboardRow[];
	totals: { running: number; queued: number; finished: number; costUsd: number };
}

const RUNNING_STATES = new Set(["queued", "running", "starting"]);

/** "sa_2fc7ac2e5893" → "2fc7ac2e" */
export function fmtShortId(id: string): string {
	return id.startsWith("sa_") ? id.slice(3, 11) : id.slice(0, 8);
}

/** 42 → "42s", 192_000 → "3m12s", 7_200_000 → "2h0m" */
export function fmtAge(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** 0.0012 → "$0.0012"; 0 → "-" */
export function fmtCost(cost: number): string {
	if (!(cost > 0)) return "-";
	return `$${cost >= 0.01 ? cost.toFixed(3) : cost.toFixed(4)}`;
}

/** Truncate to `max` chars, preserving a trailing ellipsis marker. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, Math.max(0, max - 1)) + "…";
}

/** Theme token for a child state (subset of pi's ThemeColor). */
export function stateToken(state: string): "success" | "error" | "warning" | "accent" {
	switch (state) {
		case "verified":
		case "done":
			return "success";
		case "failed":
		case "timeout":
		case "error":
			return "error";
		case "cancelled":
			return "warning";
		default:
			return "accent";
	}
}

function row(e: EntryView): DashboardRow {
	return {
		id: e.id,
		shortId: fmtShortId(e.id),
		name: displayName(e),
		agent: e.agent,
		state: e.state,
		ageMs: Date.now() - (e.startedAt || e.queuedAt),
		cost: e.usage.cost,
		summary: e.summary,
		outcome: e.outcome,
		killReason: e.killReason,
	};
}

/**
 * Shape a registry of children into a dashboard: active rows first (running
 * then queued), a capped list of most-recently-finished, and session totals.
 */
export function dashboardData(entries: EntryView[], finishedLimit = 8): Dashboard {
	const running: DashboardRow[] = [];
	const queued: DashboardRow[] = [];
	const finished: DashboardRow[] = [];
	let costUsd = 0;

	for (const e of entries) {
		costUsd += e.usage.cost;
		if (RUNNING_STATES.has(e.state)) {
			(e.state === "queued" ? queued : running).push(row(e));
		} else {
			finished.push(row(e));
		}
	}

	finished.sort((a, b) => b.ageMs - a.ageMs);
	return {
		running,
		queued,
		finished: finished.slice(0, finishedLimit),
		totals: {
			running: running.length,
			queued: queued.length,
			finished: finished.length,
			costUsd,
		},
	};
}
