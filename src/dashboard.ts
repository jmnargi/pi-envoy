/**
 * Live subagent dashboard component for the pi TUI.
 *
 * Opened from the `/envoy` command as an overlay (`ctx.ui.custom(..., {
 * overlay: true })`). Shows running/queued/finished children with age and
 * cost, refreshes every second, and can drill into one child's bus output.
 *
 * Renders as a plain component `{ render, invalidate, handleInput, dispose }`
 * per pi's custom-UI contract — no framework classes.
 */

import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";

import type { BusMessage } from "./types.ts";
import {
	dashboardData,
	fmtAge,
	fmtCost,
	fmtShortId,
	killLabel,
	stateToken,
	truncate,
	type DashboardRow,
	type EntryView,
} from "./ui.ts";
/** Structural stand-in for pi's Theme (kept internal to this file). */
export interface ThemeLike {
	fg(token: string, text: string): string;
	bold(text: string): string;
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


/** Cap displayed rows per section so the overlay stays legible. */
const MAX_RUNNING = 8;
const MAX_QUEUED = 4;
const MAX_FINISHED = 6;

interface RowLine {
	id: string;
	label: string;
	token: string;
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

	const stateLabel = (e: DashboardRow): string => (e.outcome ?? e.state).toString();

	const refresh = (): void => {
		try {
			tui.requestRender();
		} catch {
			// overlay may already be gone — ignore
		}
	};
	const timer = setInterval(refresh, 1000);

	const rowLabel = (e: DashboardRow): string => {
		const age = fmtAge(e.ageMs).padStart(6);
		const cost = fmtCost(e.cost).padStart(7);
		const summary = truncate(e.summary || stateLabel(e), 48);
		return `${e.name.padEnd(18)} ${age} ${cost}  ${summary}`;
	};

	const listRows = (): RowLine[] => {
		const d = dashboardData(deps.entries());
		const rows: RowLine[] = [];
		const take = (list: DashboardRow[], max: number): void => {
			for (const r of list.slice(0, max)) {
				rows.push({ id: r.id, label: rowLabel(r), token: stateToken(r.state) });
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
							return `[${t} ${m.from}→${m.to} ${m.kind}] ${truncate(m.text, 160)}`;
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

	return {
		render(width: number): string[] {
			if (mode !== "list") {
				if ("confirmKill" in mode) {
					const name = deps.nameOf(mode.confirmKill);
					return [
						truncate(
							`${theme.fg("toolTitle", theme.bold("envoy · kill"))} ${theme.fg("dim", name)}  ${theme.fg("warning", "terminate this subagent? (y/n)")}`,
							width,
						),
					];
				}
				const id = mode.id;
				const name = deps.nameOf(id);
				const viewLabel = mode.view === "transcript" ? "transcript" : "output";
				const head = `${theme.fg("toolTitle", theme.bold(`envoy · ${viewLabel}`))} ${theme.fg("dim", name)}  ${theme.fg("dim", "esc back · ↑/↓ scroll")}`;
				const body = outLoading
					? [theme.fg("muted", "loading…")]
					: outLines.slice(outOffset, outOffset + 20).map((l) => truncate(l, width));
				return [truncate(head, width), "", ...body];
			}

			const rows = listRows();
			const d = dashboardData(deps.entries());
			const t = d.totals;
			const title = `${theme.fg("toolTitle", theme.bold("envoy · live subagents"))}   ${theme.fg(
				"muted",
				`${t.running} running · ${t.queued} queued · ${t.finished} finished · ${fmtCost(t.costUsd)} session cost`,
			)}`;
			const out: string[] = [truncate(title, width), ""];

			const section = (name: string, rowsSlice: RowLine[], start: number, token: string): void => {
				out.push(theme.fg(token, theme.bold(name)));
				for (let i = 0; i < rowsSlice.length; i++) {
					const r = rowsSlice[i]!;
					const idx = start + i;
					const cursor = idx === selected ? "› " : "  ";
					const label = idx === selected ? theme.fg("accent", theme.bold(r.label)) : theme.fg(r.token, r.label);
					out.push(truncate(cursor + label, width));
				}
				out.push("");
			};

			const runEnd = sectionStarts[1] ?? 0;
			const finStart = sectionStarts[2] ?? 0;
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

			out.push(theme.fg("dim", "↑/↓ select · enter output · v transcript · x kill · esc close"));
			return out;
		},

		invalidate(): void {
			// no cached state to clear; next render recomputes from deps
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
