/**
 * Unit tests for the envoy message-interjection helpers (src/interject.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BusMessage } from "../src/types.ts";
import {
	formatInjectedMessage,
	injectableKind,
	parseInboxLine,
	readNewInbox,
} from "../src/interject.ts";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-envoy-interject-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const msg = (over: Partial<BusMessage>): BusMessage => ({
	ts: 1000,
	from: "sa_parent",
	to: "sa_child",
	kind: "steer",
	text: "focus on error handling",
	...over,
});

describe("parseInboxLine", () => {
	test("parses a valid JSONL line", () => {
		const m = parseInboxLine(JSON.stringify(msg({})));
		expect(m).not.toBeNull();
		expect(m?.kind).toBe("steer");
		expect(m?.text).toBe("focus on error handling");
	});

	test("returns null for blank lines", () => {
		expect(parseInboxLine("")).toBeNull();
		expect(parseInboxLine("   ")).toBeNull();
	});

	test("returns null for corrupt lines", () => {
		expect(parseInboxLine("not json at all")).toBeNull();
		expect(parseInboxLine('{"ts": "nope", "from": 1}')).toBeNull();
	});
});

describe("injectableKind", () => {
	test("steer/question/reply/escalation/announcement inject", () => {
		for (const k of ["steer", "question", "reply", "escalation", "announcement"] as const) {
			expect(injectableKind(k)).toBe(true);
		}
	});

	test("progress and result do not inject", () => {
		expect(injectableKind("progress")).toBe(false);
		expect(injectableKind("result")).toBe(false);
	});
});

describe("formatInjectedMessage", () => {
	test("prefixes with the sender", () => {
		expect(formatInjectedMessage(msg({ from: "sa_parent" }))).toBe(
			"[envoy: sa_parent] focus on error handling",
		);
	});

	test("maps an empty sender to main", () => {
		expect(formatInjectedMessage(msg({ from: "" }))).toBe("[envoy: main] focus on error handling");
	});
});

describe("readNewInbox", () => {
	test("returns messages after the cursor and advances it", () => {
		const file = path.join(tmp, "in.jsonl");
		fs.writeFileSync(
			file,
			[JSON.stringify(msg({ ts: 1, kind: "steer", text: "a" })), JSON.stringify(msg({ ts: 2, kind: "question", text: "b" }))].join("\n") + "\n",
		);
		const first = readNewInbox(file, 0);
		expect(first.messages.map((m) => m.text)).toEqual(["a", "b"]);
		expect(first.nextCursor).toBe(2);

		const second = readNewInbox(file, first.nextCursor);
		expect(second.messages).toHaveLength(0);
		expect(second.nextCursor).toBe(2);
	});

	test("skips corrupt lines but still advances past them", () => {
		const file = path.join(tmp, "in.jsonl");
		fs.writeFileSync(file, "garbage\n" + JSON.stringify(msg({ text: "ok" })) + "\n");
		const r = readNewInbox(file, 0);
		expect(r.messages.map((m) => m.text)).toEqual(["ok"]);
		expect(r.nextCursor).toBe(2);
	});

	test("missing file resets the cursor to 0", () => {
		const r = readNewInbox(path.join(tmp, "missing.jsonl"), 5);
		expect(r.messages).toHaveLength(0);
		expect(r.nextCursor).toBe(0);
	});

	test("appended lines are picked up on the next poll", () => {
		const file = path.join(tmp, "in.jsonl");
		fs.writeFileSync(file, JSON.stringify(msg({ text: "first" })) + "\n");
		const first = readNewInbox(file, 0);
		expect(first.messages).toHaveLength(1);
		fs.appendFileSync(file, JSON.stringify(msg({ text: "second" })) + "\n");
		const second = readNewInbox(file, first.nextCursor);
		expect(second.messages.map((m) => m.text)).toEqual(["second"]);
	});
});
