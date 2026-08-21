/**
 * Factory-surface tests: what the plugin exposes to the host (pi) and, through
 * pi, to the model — tools with snippets/guidelines, commands, and events.
 * Guards the "how the model learns about envoy" contract in README.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setDataDirForTests } from "../src/config.ts";
import makeEnvoy from "../src/index.ts";

// Minimal structural stand-in for the pi ExtensionAPI; only the members the
// factory touches at registration time are implemented.
interface RegisteredTool {
	name: string;
	label: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

interface FakePi {
	pi: ExtensionAPI;
	tools: RegisteredTool[];
	commands: string[];
	events: string[];
}

function makeFakePi(): FakePi {
	const tools: RegisteredTool[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	// Unchecked cast: fake stands in for pi's full surface; registration-only members are exercised.
	const surface = {
		registerTool: (t: RegisteredTool) => tools.push(t),
		registerCommand: (_name: string, _def: unknown) => commands.push(_name),
		on: (event: string, _handler: unknown) => events.push(event),
		sendUserMessage: () => Promise.resolve(),
	} as unknown as ExtensionAPI;
	return { pi: surface, tools, commands, events };
}

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-envoy-factory-"));
	setDataDirForTests(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const EXPECTED_TOOLS = [
	"subagent_spawn",
	"subagent_wait",
	"subagent_status",
	"subagent_messages",
	"subagent_send",
	"subagent_post",
	"subagent_reputation",
	"subagent_cancel",
	"subagent_cleanup",
];

describe("extension factory surface", () => {
	test("registers all 9 subagent_* tools with names and labels", () => {
		const fake = makeFakePi();
		makeEnvoy(fake.pi);
		expect(fake.tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
		for (const t of fake.tools) expect(t.label.length).toBeGreaterThan(0);
	});

	test("every tool has a promptSnippet so it appears in Available tools", () => {
		const fake = makeFakePi();
		makeEnvoy(fake.pi);
		for (const t of fake.tools) {
			expect(t.promptSnippet).toBeDefined();
			expect(t.promptSnippet!.length).toBeGreaterThan(10);
		}
	});

	test("subagent_spawn guidelines encode the delegation workflow", () => {
		const fake = makeFakePi();
		makeEnvoy(fake.pi);
		const spawn = fake.tools.find((t) => t.name === "subagent_spawn");
		expect(spawn?.promptGuidelines).toHaveLength(4);
		for (const g of spawn?.promptGuidelines ?? []) {
			expect(g.startsWith("subagent_spawn:")).toBe(true);
		}
		const joined = spawn?.promptGuidelines?.join(" ") ?? "";
		expect(joined).toContain("precise contract");
		expect(joined).toContain("untrusted data");
		expect(joined).toContain("wait=true");
	});

	test("subagent_send guidelines describe instant interjection", () => {
		const fake = makeFakePi();
		makeEnvoy(fake.pi);
		const send = fake.tools.find((t) => t.name === "subagent_send");
		expect(send?.promptGuidelines?.join(" ")).toContain("injected into the child's conversation");
	});

	test("registers envoy commands and session lifecycle events", () => {
		const fake = makeFakePi();
		makeEnvoy(fake.pi);
		expect(fake.commands).toContain("envoy");
		expect(fake.commands).toContain("envoy-cleanup");
		expect(fake.events).toContain("session_start");
		expect(fake.events).toContain("session_shutdown");
	});
});
