/**
 * Message bus (§4.5 monitoring; inter-agent communication).
 *
 * The bus is a set of append-only JSONL files under `<dataDir>/bus`:
 *   - `<id>.in.jsonl`      per-agent inbox
 *   - `main.jsonl`         the outermost (main) agent's inbox
 *   - `groups/<g>.jsonl`   shared group channels for sibling families
 *
 * All ids and group names are validated against a strict character set so
 * untrusted addresses can never smuggle path separators or `..` into the
 * filesystem namespace.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BusMessage, ParentContext } from "./types.ts";

/** Characters allowed in bus ids (agent ids and group names). */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Subagent ids follow the `sa_<lowercase alnum>` convention (see resolveAddress). */
const SUBAGENT_ADDR_RE = /^sa_[a-z0-9]+$/;

function assertSafeId(id: string): void {
	if (!SAFE_ID_RE.test(id)) {
		throw new Error(`invalid bus id: ${id}`);
	}
}

/**
 * Path of one agent's inbox: `<dataDir>/bus/<id>.in.jsonl`.
 * Throws on ids containing path separators or `..`.
 */
export function inboxPath(dataDir: string, id: string): string {
	assertSafeId(id);
	return path.join(dataDir, "bus", `${id}.in.jsonl`);
}

/** Path of the outermost agent's inbox: `<dataDir>/bus/main.jsonl`. */
export function mainInboxPath(dataDir: string): string {
	return path.join(dataDir, "bus", "main.jsonl");
}

/** Path of a group channel: `<dataDir>/bus/groups/<group>.jsonl`. */
export function groupPath(dataDir: string, group: string): string {
	assertSafeId(group);
	return path.join(dataDir, "bus", "groups", `${group}.jsonl`);
}

/**
 * Append one message as a single JSON line to a bus file (atomically via
 * O_APPEND), creating parent directories as needed. Rejects with a TypeError
 * when the message is missing `ts`, `from`, `to` or `text`.
 */
export async function postMessage(file: string, msg: BusMessage): Promise<void> {
	if (
		typeof msg.ts !== "number" ||
		typeof msg.from !== "string" ||
		typeof msg.to !== "string" ||
		typeof msg.text !== "string"
	) {
		throw new TypeError("bus message requires ts, from, to and text");
	}
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await fs.promises.appendFile(file, JSON.stringify(msg) + "\n", "utf8");
}

/**
 * Read messages from a bus file. A missing file reads as `[]`; corrupt lines
 * are skipped silently. When `sinceMs` is given only messages with
 * `ts > sinceMs` are returned (cursor semantics). Results are sorted by `ts`
 * ascending.
 */
export async function readMessages(file: string, sinceMs?: number): Promise<BusMessage[]> {
	let content: string;
	try {
		content = await fs.promises.readFile(file, "utf8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const messages: BusMessage[] = [];
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const msg = JSON.parse(line) as BusMessage;
			if (sinceMs === undefined || msg.ts > sinceMs) messages.push(msg);
		} catch {
			// Corrupt line — skip silently.
		}
	}
	messages.sort((a, b) => a.ts - b.ts);
	return messages;
}

/**
 * Resolve a `to` address to a bus file path:
 *   "main"   → ctx.mainInbox
 *   "parent" → inbox of ctx.parentId, or ctx.mainInbox when there is no parent
 *   "group"  → the group channel for ctx.group
 *   <id>     → inbox of that id, when it matches /^sa_[a-z0-9]+$/
 * Anything else throws `bad address: <to>`.
 */
export function resolveAddress(ctx: ParentContext, to: string): string {
	switch (to) {
		case "main":
			return ctx.mainInbox;
		case "parent":
			return ctx.parentId ? inboxPath(ctx.dataDir, ctx.parentId) : ctx.mainInbox;
		case "group":
			return groupPath(ctx.dataDir, ctx.group);
		default:
			if (SUBAGENT_ADDR_RE.test(to)) return inboxPath(ctx.dataDir, to);
			throw new Error(`bad address: ${to}`);
	}
}
