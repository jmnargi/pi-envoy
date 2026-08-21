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
 * Read messages from an inbox file that are newer than `cursor` (a byte
 * offset). Returns the parsed messages and the new cursor (byte offset of the
 * end of the last complete line consumed).
 *
 * The read is incremental: only bytes after `cursor` are read, so a poll
 * costs O(appended bytes), not O(file size) — the watcher stays cheap no
 * matter how large a busy inbox grows.
 *
 * A missing file (pruned/rotated) resets the cursor to 0 so a freshly created
 * inbox starts delivering again; a file that shrank below the cursor (truncate
 * or rotate-to-smaller) is handled the same way.
 *
 * An in-flight append may leave a partial trailing line without a newline;
 * it is not parsed yet and the cursor stays at its start, so the next poll
 * picks it up complete — no message is lost or split.
 */
export function readNewInbox(file: string, cursor: number): { messages: BusMessage[]; nextCursor: number } {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return { messages: [], nextCursor: 0 };
	}
	try {
		const size = fs.fstatSync(fd).size;
		if (size < cursor) cursor = 0; // truncated or rotated
		const length = size - cursor;
		if (length <= 0) return { messages: [], nextCursor: cursor };
		const buf = Buffer.allocUnsafe(length);
		let got = 0;
		while (got < length) {
			const n = fs.readSync(fd, buf, got, length - got, cursor + got);
			if (n <= 0) break;
			got += n;
		}
		// Only advance past newline-terminated (complete) lines; a trailing
		// fragment without "\n" is re-read together with its completion.
		const lastNl = buf.lastIndexOf(0x0a);
		if (lastNl < 0) return { messages: [], nextCursor: cursor };
		const messages: BusMessage[] = [];
		for (const line of buf.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
			const m = parseInboxLine(line);
			if (m) messages.push(m);
		}
		return { messages, nextCursor: cursor + lastNl + 1 };
	} finally {
		fs.closeSync(fd);
	}
}
