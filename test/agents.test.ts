/**
 * Tests for the default task agent and bundled-profile discovery.
 *
 * The core "install-and-run" promise: `subagent_spawn` with no `agent`
 * resolves to a built-in task subagent with a system prompt that tells it
 * how to behave as a subagent and how to message the parent/siblings.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultTaskAgent, discoverBundledAgents } from "../src/agents.ts";

describe("defaultTaskAgent", () => {
	test("is named task with a real system prompt", () => {
		const a = defaultTaskAgent();
		expect(a.name).toBe("task");
		expect(a.systemPrompt.length).toBeGreaterThan(200);
	});

	test("system prompt tells it it is a subagent and how to communicate", () => {
		const sp = defaultTaskAgent().systemPrompt;
		expect(sp).toContain("task subagent");
		expect(sp).toContain("parent");
		expect(sp).toContain("sibling");
		expect(sp).toContain("SUMMARY:");
		expect(sp).toContain("SELF_REPORT:");
	});
});

describe("discoverBundledAgents", () => {
	test("finds the repo's agent profiles", () => {
		const agents = discoverBundledAgents();
		const names = agents.map((a) => a.name);
		expect(names).toContain("worker");
		expect(names).toContain("scout");
		expect(names).toContain("planner");
		expect(names).toContain("reviewer");
		for (const a of agents) {
			expect(a.systemPrompt.length).toBeGreaterThan(50);
		}
	});
});
