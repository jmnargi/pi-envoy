/**
 * Instant message injection for envoy agents.
 *
 * Incoming bus messages meant for this agent are delivered proactively: the
 * watcher in src/index.ts polls the agent's own inbox file and, for every new
 * message, injects it as a CUSTOM message via `pi.sendMessage({ customType:
 * "envoy-message", triggerTurn: true })`. A `registerMessageRenderer`
 * handler renders it with a distinct TUI appearance (provenance + styled
 * text) instead of a plain user message, and `triggerTurn: true` makes the
 * model see it as a turn-triggering context message — so the model never has
 * to poll its inbox or remember to check it.
 *
 * This module keeps the pure, unit-testable parts: line parsing, cursor
 * accounting, kind filtering, and message shaping.
 */

import * as fs from "node:fs";

import type { BusMessage } from "./types.ts";

/** Poll cadence for the inbox watcher (§4.5 monitoring — push-style delivery). */
export const INTERJECT_POLL_MS = 750;

/** The pi customType used for envoy-injected messages (matches the renderer). */
export const ENVOY_MESSAGE_CUSTOM_TYPE = "envoy-message";

/** Kinds that warrant interrupting the agent (progress is parent-side chatter). */
const INJECTABLE_KINDS: Record<string, true> = {
	steer: true,
	question: true,
	reply: true,
	escalation: true,
	announcement: true,
};

/** Whether a message kind should be injected as an interrupting message (exported injection policy). */
export function injectableKind(kind: BusMessage["kind"]): boolean {
	return INJECTABLE_KINDS[kind] === true;
}

/** Sender label for the injected message (the empty sender means "main"). */
export function senderLabel(m: BusMessage): string {
	return m.from === "" ? "main" : m.from;
}

/**
 * Shape the message payload for `pi.sendMessage`. The renderer reads
 * `details.from` (provenance) and `details.kind` to render a distinct TUI
 * block; `content` is the text the model consumes as context.
 */
export function formatInjectedMessage(m: BusMessage): {
	customType: string;
	content: string;
	display: boolean;
	details: { from: string; kind: string; ts: number };
} {
	return {
		customType: ENVOY_MESSAGE_CUSTOM_TYPE,
		content: m.text,
		display: true,
		details: { from: senderLabel(m), kind: m.kind, ts: m.ts },
	};
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
