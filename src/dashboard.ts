/**
 * Fullscreen subagent dashboard for the pi TUI.
 *
 * Opened from the `/envoy` command via `ui.custom` (no overlay → replaces the
 * editor, i.e. fullscreen). Fixed to the terminal window: the frame spans the
 * full width and fills the height, so it never re-sizes on its own.
 *
 * Shows running/queued/finished children with name, model, thinking level,
 * tokens in/out, cost and age; a live activity feed streams the most recent
 * line from every running child; and you can drill into a child's bus output
 * / transcript or kill it (x → y/n).
 */

import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type { BusMessage } from "./types.ts";
import { dashboardData, fmtAge, fmtCost, fmtModel, fmtThinking, fmtTokens, killLabel, stateToken, type DashboardRow, type EntryView } from "./ui.ts";
/** Structural stand-in for pi's Theme (kept internal to this file). */
export interface ThemeLike {
	fg(token: string, text: string): string;
	bold(text: string): string;
	bg(token: string, text: string): string;
}

export interface DashboardDeps {
	/** Snapshot of the child registry (pure view). */
	entries(): EntryView[];
	readOutbox(id: string): Promise<BusMessage[]>;
	/** Read a child's captured transcript lines (assistant/tool messages). */
	readTranscript(id: string): Promise<string[]>;
	/** Human summary/result line of one child. */
	summaryOf(id: string): string;
	/** Human-readable display name of one child. */
	nameOf(id: string): string;
	/** Request termination of a running/queued child ("cancelled" attribution). */
	kill(id: string): string | null;
}


/** Cap displayed rows per section so the dashboard stays legible. */
const MAX_RUNNING = 8;
const MAX_QUEUED = 4;
const MAX_FINISHED = 6;

interface RowLine {
	id: string;
	label: string;
	token: string;
}

/** Fixed column widths for the compact per-child row (keeps the layout stable). */
const COL = {
	name: 16,
	model: 14,
	think: 5,
	tok: 7,
	cost: 8,
	age: 7,
} as const;

/** Compact one-line summary of a child's live usage + identity. */
export function compactRowLabel(e: DashboardRow): string {
	const name = e.name.slice(0, COL.name).padEnd(COL.name);
	const model = fmtModel(e.model).slice(0, COL.model).padEnd(COL.model);
	const think = fmtThinking(e.thinking).padStart(COL.think);
	const up = fmtTokens(e.input).padStart(COL.tok);
	const down = fmtTokens(e.output).padStart(COL.tok);
	const cost = fmtCost(e.cost).padStart(COL.cost);
	const age = fmtAge(e.ageMs).padStart(COL.age);
	return `${name} ${model} ${think} ↑${up} ↓${down} ${cost} ${age}`;
}

export function makeDashboardComponent(
	deps: DashboardDeps,
	tui: TUI,
	theme: ThemeLike,
	done: () => void,
): Component & { dispose(): void } {
	let mode: "list" | { id: string; view: "output" | "transcript" } | { confirmKill: string } = "list";
	let selected = 0;
	let sectionStarts = [0, 0, 0];
	let outLines: string[] = [];
	let outLoading = false;
	let outOffset = 0;

	const border = (s: string): string => theme.fg("border", s);
	const title = (s: string): string => theme.fg("accent", theme.bold(s));
	const header = (s: string): string => theme.fg("muted", theme.bold(s));

	const stateLabel = (e: DashboardRow): string => (e.outcome ?? e.state).toString();

	let lastSignature = "";
	const refresh = (): void => {
		try {
			tui.requestRender();
		} catch {
			// overlay may already be gone — ignore
		}
	};
	/** Re-render only when something actually changed (kills the flicker):
	 *  a cheap signature of registry state + activity, compared each tick. */
	const timer = setInterval(() => {
		const d = dashboardData(deps.entries());
		const sig = [
			d.totals.running,
			d.totals.queued,
			d.totals.finished,
			d.totals.costUsd.toFixed(6),
			...d.running.map((r) => `${r.id}:${Math.floor(r.ageMs / 1000)}:${fmtTokens(r.input)}:${fmtTokens(r.output)}:${r.lastActivity?.slice(0, 60) ?? ""}`),
			mode !== "list" ? outOffset : "",
		].join("|");
		if (sig !== lastSignature) {
			lastSignature = sig;
			refresh();
		}
	}, 1000);

	const listRows = (): RowLine[] => {
		const d = dashboardData(deps.entries());
		const rows: RowLine[] = [];
		const take = (list: DashboardRow[], max: number): void => {
			for (const r of list.slice(0, max)) {
				rows.push({ id: r.id, label: compactRowLabel(r), token: stateToken(r.state) });
			}
		};
		take(d.running, MAX_RUNNING);
		sectionStarts[1] = rows.length;
		take(d.queued, MAX_QUEUED);
		sectionStarts[2] = rows.length;
		take(d.finished, MAX_FINISHED);
		if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
		return rows;
	};

	const loadView = async (id: string, view: "output" | "transcript"): Promise<void> => {
		mode = { id, view };
		outLoading = true;
		outOffset = 0;
		outLines = [];
		refresh();
		try {
			const lines =
				view === "transcript"
					? await deps.readTranscript(id)
					: (await deps.readOutbox(id)).map((m) => {
							const t = new Date(m.ts).toISOString().slice(11, 19);
							return `[${t} ${m.from}→${m.to} ${m.kind}] ${truncateToWidth(m.text, 160)}`;
						});
			outLines = lines.length > 0 ? lines : [view === "transcript" ? "(no transcript yet)" : "(no bus messages yet)"];
			if (view === "output") outLines.push("", "— final summary —", deps.summaryOf(id) || "(no summary)");
		} catch {
			outLines = ["(failed to read)"];
		}
		outLoading = false;
		refresh();
	};

	const openOutput = (id: string): Promise<void> => loadView(id, "output");

	/** Build the popup's inner content lines for the current mode. */
	const contentLines = (width: number): string[] => {
		if (mode !== "list") {
			if ("confirmKill" in mode) {
				const name = deps.nameOf(mode.confirmKill);
				return [
					truncateToWidth(`${title("envoy · kill")} ${theme.fg("dim", name)}  ${theme.fg("warning", "terminate this subagent? (y/n)")}`, width),
				];
			}
			const id = mode.id;
			const name = deps.nameOf(id);
			const viewLabel = mode.view === "transcript" ? "transcript" : "output";
			const head = `${title(`envoy · ${viewLabel}`)} ${theme.fg("dim", name)}  ${theme.fg("dim", "esc back · ↑/↓ scroll")}`;
			const bodyLines = outLoading
				? [theme.fg("muted", "loading…")]
				: outLines.slice(outOffset, outOffset + 20).map((l) => truncateToWidth(l, width));
			return [truncateToWidth(head, width), "", ...bodyLines];
		}

		const rows = listRows();
		const d = dashboardData(deps.entries());
		const t = d.totals;
		const head = `${title("envoy · live subagents")}   ${theme.fg(
			"muted",
			`${t.running} running · ${t.queued} queued · ${t.finished} finished · ${fmtCost(t.costUsd)} session cost`,
		)}`;
		const out: string[] = [truncateToWidth(head, width), ""];

		const section = (name: string, rowsSlice: RowLine[], start: number, token: string): void => {
			out.push(header(name));
			for (let i = 0; i < rowsSlice.length; i++) {
				const r = rowsSlice[i]!;
				const idx = start + i;
				const cursor = idx === selected ? "› " : "  ";
				const label = idx === selected ? theme.fg("accent", theme.bold(r.label)) : theme.fg(r.token, r.label);
				out.push(truncateToWidth(cursor + label, width));
			}
			out.push("");
		};

		const runEnd = sectionStarts[1] ?? 0;
		const finStart = sectionStarts[2] ?? 0;
		out.push(
			truncateToWidth(
				theme.fg(
					"dim",
					`${"name".padEnd(COL.name)} ${"model".padEnd(COL.model)} ${"think".padStart(COL.think)} ${"↑in".padStart(COL.tok)} ${"↓out".padStart(COL.tok)} ${"cost".padStart(COL.cost)} ${"age".padStart(COL.age)}`,
				),
				width,
			),
		);
		section("RUNNING", rows.slice(0, runEnd), 0, "accent");
		section("QUEUED", rows.slice(runEnd, finStart), runEnd, "muted");
		section("FINISHED", rows.slice(finStart), finStart, "dim");

		// Kill attribution for the selected finished row, if any.
		const selRow = rows[selected];
		if (selRow) {
			const finishedRow = Array.from(d.finished).find((f) => f.id === selRow.id);
			const killed = finishedRow ? killLabel(finishedRow.killReason) : null;
			if (killed) out.push(theme.fg("warning", `⚠ ${selRow.label} — ${killed}`));
		}

		// Live activity feed: the most recent line from each running child.
		const active = d.running.filter((r) => r.lastActivity && r.lastActivity.trim() !== "");
		if (active.length > 0) {
			out.push("", header("LIVE ACTIVITY"));
			for (const r of active.slice(0, 5)) {
				const line = truncateToWidth(`${r.name}: ${r.lastActivity!.trim().replace(/\s+/g, " ")}`, width - 4);
				out.push(theme.fg("muted", line));
			}
		}

		out.push(theme.fg("dim", "↑/↓ select · enter output · v transcript · x kill · esc close"));
		return out;
	};

	/** Frame content lines with a full box (4 sides) at the given width.
	 *  Padding/truncation are ANSI-aware: escape codes don't count toward
	 *  the width, so the right border sits at the true terminal edge. */
	const frame = (content: string[], width: number): string[] => {
		const inner = Math.max(1, width - 2);
		const top = border("┌" + "─".repeat(inner) + "┐");
		const bottom = border("└" + "─".repeat(inner) + "┘");
		const framed = content.map((line) => {
			const fitted = truncateToWidth(line, inner);
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
			return border("│") + fitted + pad + border("│");
		});
		return [top, ...framed, bottom];
	};

	return {
		render(width: number): string[] {
			const content = contentLines(Math.max(10, width - 2));

			// Fixed size: in fullscreen mode fill the terminal height (help line
			// pinned to the bottom border); in regular mode the panel lives in
			// the editor region, so keep it compact — content-sized with a cap —
			// because a full-height block there forces re-layouts while the chat
			// streams (the flicker).
			const isFullscreen = tui.mode === "fullscreen";
			let height = content.length + 2;
			try {
				const rows = tui.terminal?.rows;
				if (isFullscreen && typeof rows === "number" && Number.isFinite(rows) && rows > 4) {
					height = rows - 2;
				} else if (!isFullscreen) {
					height = Math.min(content.length + 2, 20);
				}
			} catch {
				// terminal size unknown — fall back to content height
			}

			const filled = [...content];
			const helpIdx = filled.length - 1;
			while (filled.length < height - 2) {
				filled.splice(helpIdx, 0, "");
			}
			if (filled.length > height - 2) filled.length = height - 2;

			return frame(filled, width);
		},

		invalidate(): void {
			// stateless render — nothing cached
		},

		async handleInput(data: string): Promise<void> {
			if (mode !== "list") {
				if ("confirmKill" in mode) {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
						mode = "list";
						refresh();
						return;
					}
					// y / Y confirm the kill
					if (data === "y" || data === "Y") {
						const id = mode.confirmKill;
						const result = deps.kill(id);
						mode = "list";
						outLines = result ? [`killed ${id}: ${result}`] : [];
						refresh();
						return;
					}
					// n / N cancels the confirm
					if (data === "n" || data === "N") {
						mode = "list";
						refresh();
					}
					return;
				}
				if (matchesKey(data, Key.escape)) mode = "list";
				else if (matchesKey(data, Key.up)) outOffset = Math.max(0, outOffset - 1);
				else if (matchesKey(data, Key.down)) outOffset++;
				refresh();
				return;
			}
			const rows = listRows();
			const count = rows.length;
			if (matchesKey(data, Key.down)) selected = Math.min(count - 1, selected + 1);
			else if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
			else if (matchesKey(data, Key.enter) && count > 0) await openOutput(rows[selected]!.id);
			else if ((data === "v" || data === "V") && count > 0) await loadView(rows[selected]!.id, "transcript");
			else if ((data === "x" || data === "X" || data === "k" || data === "K") && count > 0) {
				mode = { confirmKill: rows[selected]!.id };
			} else if (matchesKey(data, Key.escape)) {
				done();
				return;
			}
			refresh();
		},

		dispose(): void {
			clearInterval(timer);
		},
	};
}
