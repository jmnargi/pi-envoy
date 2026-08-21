/**
 * Tests for the file-based message bus (§4.5): JSONL roundtrips, address
 * resolution, corrupt-line tolerance and id validation.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { groupPath, inboxPath, mainInboxPath, postMessage, readMessages, resolveAddress } from "../src/bus.ts";
import type { BusMessage, ParentContext } from "../src/types.ts";

function tmpDir(): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-envoy-bus-"));
}

function makeCtx(dir: string, overrides?: Partial<ParentContext>): ParentContext {
	return {
		id: "sa_delegator",
		parentId: "sa_parent",
		group: "grp_demo",
		depth: 1,
		dataDir: dir,
		inbox: inboxPath(dir, "sa_delegator"),
		mainInbox: mainInboxPath(dir),
		maxDepth: 3,
		...overrides,
	};
}

describe("bus paths", () => {
	test("inbox/group/main paths follow the bus layout", async () => {
		const dir = await tmpDir();
		try {
			expect(inboxPath(dir, "sa_worker")).toBe(path.join(dir, "bus", "sa_worker.in.jsonl"));
			expect(mainInboxPath(dir)).toBe(path.join(dir, "bus", "main.jsonl"));
			expect(groupPath(dir, "grp_demo")).toBe(path.join(dir, "bus", "groups", "grp_demo.jsonl"));
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("bus post/read", () => {
	test("roundtrip appends one JSON line per message", async () => {
		const dir = await tmpDir();
		try {
			const file = inboxPath(dir, "sa_worker");
			const m1: BusMessage = {
				ts: 1000,
				from: "sa_parent",
				to: "sa_worker",
				kind: "progress",
				text: "started",
			};
			const m2: BusMessage = {
				ts: 2000,
				from: "sa_parent",
				to: "sa_worker",
				kind: "checkpoint",
				text: "halfway",
			};
			await postMessage(file, m1);
			await postMessage(file, m2);
			const raw = await fs.promises.readFile(file, "utf8");
			expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
			expect(JSON.parse(raw.split("\n")[0]!)).toEqual(m1);
			expect(JSON.parse(raw.split("\n")[1]!)).toEqual(m2);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("readMessages sorts ascending, honors the sinceMs cursor, and reads missing files as []", async () => {
		const dir = await tmpDir();
		try {
			const file = inboxPath(dir, "sa_worker");
			const m1: BusMessage = { ts: 1000, from: "a", to: "b", kind: "progress", text: "1" };
			const m2: BusMessage = { ts: 2000, from: "a", to: "b", kind: "progress", text: "2" };
			const m3: BusMessage = { ts: 1500, from: "a", to: "b", kind: "steer", text: "out of order" };
			await postMessage(file, m1);
			await postMessage(file, m2);
			await postMessage(file, m3);
			expect(await readMessages(file)).toEqual([m1, m3, m2]); // ascending ts order
			expect(await readMessages(file, 1500)).toEqual([m2]); // strict > sinceMs
			expect(await readMessages(file, 2000)).toEqual([]);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("corrupt lines are skipped silently", async () => {
		const dir = await tmpDir();
		try {
			const file = inboxPath(dir, "sa_worker");
			await fs.promises.mkdir(path.dirname(file), { recursive: true });
			await fs.promises.writeFile(
				file,
				'{"ts":1,"from":"a","to":"b","kind":"progress","text":"ok"}\nnot json\n\n{"ts":3,"from":"a","to":"b","kind":"result","text":"later"}\n',
				"utf8",
			);
			const msgs = await readMessages(file);
			expect(msgs).toHaveLength(2);
			expect(msgs[0]!.text).toBe("ok");
			expect(msgs[1]!.text).toBe("later");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("postMessage rejects messages missing required fields", async () => {
		const dir = await tmpDir();
		try {
			const file = inboxPath(dir, "sa_worker");
			await expect(
				postMessage(file, { ts: 1, from: "a", to: "b", kind: "progress" } as unknown as BusMessage),
			).rejects.toThrow(TypeError);
			await expect(
				postMessage(file, { from: "a", to: "b", text: "x" } as unknown as BusMessage),
			).rejects.toThrow(TypeError);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveAddress", () => {
	test("maps main/parent/group and sa_ ids to bus files", async () => {
		const dir = await tmpDir();
		try {
			const c = makeCtx(dir);
			expect(resolveAddress(c, "main")).toBe(c.mainInbox);
			expect(resolveAddress(c, "parent")).toBe(inboxPath(dir, "sa_parent"));
			expect(resolveAddress(c, "group")).toBe(groupPath(dir, "grp_demo"));
			expect(resolveAddress(c, "sa_other")).toBe(inboxPath(dir, "sa_other"));
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("parent falls back to the main inbox when there is no parent", async () => {
		const dir = await tmpDir();
		try {
			const root = makeCtx(dir, { parentId: null });
			expect(resolveAddress(root, "parent")).toBe(root.mainInbox);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("rejects bad addresses", async () => {
		const dir = await tmpDir();
		try {
			const c = makeCtx(dir);
			expect(() => resolveAddress(c, "worker")).toThrow(/bad address/);
			expect(() => resolveAddress(c, "SA_WORKER")).toThrow(/bad address/);
			expect(() => resolveAddress(c, "sa_x/../etc")).toThrow();
			expect(() => resolveAddress(c, "../evil")).toThrow();
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("id validation rejects path traversal", async () => {
		const dir = await tmpDir();
		try {
			expect(() => inboxPath(dir, "../evil")).toThrow();
			expect(() => inboxPath(dir, "a/b")).toThrow();
			expect(() => inboxPath(dir, "..")).toThrow();
			expect(() => groupPath(dir, "../evil")).toThrow();
			expect(() => groupPath(dir, "..")).toThrow();
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
