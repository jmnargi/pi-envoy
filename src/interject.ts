/**
 * Instant message injection for envoy agents.
 *
 * Incoming bus messages meant for this agent are delivered proactively: the
 * watcher in src/index.ts polls the agent's own inbox file and, for every new
 * message, injects it as a user message via `pi.sendUserMessage(...,
 * { deliverAs: "steer" })` — pi delivers that right after the current
 * assistant turn finishes its tool calls (immediately when idle). The model
 * never has to poll for messages.
 *
 * This module keeps the pure, unit-testable parts: line parsing, cursor
 * accounting, kind filtering, and message formatting.
 */

import * as fs from "node:fs";

import type { BusMessage } from "./types.ts";

/** Poll cadence for the inbox watcher (§4.5 monitoring — push-style delivery). */
export const INTERJECT_POLL_MS = 750;

/** Kinds that warrant interrupting the agent (progress is parent-side chatter). */
const INJECTABLE_KINDS: Record<string, true> = {
	steer: true,
	question: true,
	reply: true,
	escalation: true,
	announcement: true,
};

/** Whether a message kind should be injected as an interrupting user message (exported injection policy). */
export function injectableKind(kind: BusMessage["kind"]): boolean {
	return INJECTABLE_KINDS[kind] === true;
}

/** Render an inbound message as the text of an injected user message. */
export function formatInjectedMessage(m: BusMessage): string {
	const from = m.from === "" ? "main" : m.from;
	return `[envoy: ${from}] ${m.text}`;
}

/** Parse one JSONL line into a BusMessage; tolerates blank/corrupt lines. */
export function parseInboxLine(line: string): BusMessage | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const o = JSON.parse(trimmed) as Partial<BusMessage>;
		if (
			typeof o.ts === "number" &&
			typeof o.from === "string" &&
			typeof o.to === "string" &&
			typeof o.kind === "string" &&
			typeof o.text === "string"
		) {
			return o as BusMessage;
		}
	} catch {
		// corrupt line — skip
	}
	return null;
}

/**
 * Read messages from an inbox file that are newer than `cursor` (a line
 * count). Returns the parsed messages and the new cursor (total line count).
 * A missing file (pruned/rotated) resets the cursor to 0 so a freshly created
 * inbox starts delivering again.
 */
export function readNewInbox(file: string, cursor: number): { messages: BusMessage[]; nextCursor: number } {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return { messages: [], nextCursor: 0 };
	}
	const lines = raw.split("\n");
	// drop the empty element produced by a trailing newline, so cursors count real lines
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const total = lines.length;
	if (total <= cursor) return { messages: [], nextCursor: cursor };
	const messages: BusMessage[] = [];
	for (const line of lines.slice(cursor)) {
		const m = parseInboxLine(line);
		if (m) messages.push(m);
	}
	return { messages, nextCursor: total };
}
