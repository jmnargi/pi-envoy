/**
 * src/agents.ts — agent profile discovery (§4.2 role & boundary specification).
 *
 * Profiles are markdown files with YAML frontmatter, loaded from two places:
 *   - user dir:    `<agentDir>/agents`              (global, always available)
 *   - project dir: nearest ancestor of `cwd` containing `<CONFIG_DIR_NAME>/agents`
 *
 * Frontmatter fields: `name` (fallback: file stem), `description`, `tools`
 * (comma string or YAML list), `model`, and an optional `autonomyHint` that is
 * intentionally ignored at discovery time (the delegator decides autonomy per
 * spawn). The body is the system prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

import type { AgentDiscoveryResult, AgentProfile, AgentScope } from "./types.ts";

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	autonomyHint?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * Anything else (a number, a map, a nested list) yields no tools rather than
 * throwing: this runs inside agent discovery, where a single bad file must not
 * take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentProfile[] {
	const agents: AgentProfile[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		// name falls back to the file stem; a file with neither a name nor a
		// body carries nothing usable, so it is skipped.
		const name =
			typeof frontmatter.name === "string" && frontmatter.name.trim() !== ""
				? frontmatter.name
				: path.basename(filePath, ".md");
		if (name === "" && body.trim() === "") continue;

		agents.push({
			name,
			description: typeof frontmatter.description === "string" ? frontmatter.description : "",
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	agents.sort((a, b) => a.name.localeCompare(b.name));
	return agents;
}

/**
 * Walk up from `cwd` to the filesystem root looking for the nearest directory
 * containing `<CONFIG_DIR_NAME>/agents`, starting with `cwd` itself.
 */
function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// not present or not accessible — keep walking up
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Discover agent profiles for `scope`:
 *   - "user"    → the user-level agents directory only
 *   - "project" → the nearest project agents directory only
 *   - "both"    → both, with project agents overriding same-named user agents
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentProfile>();

	if (scope === "project") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else {
		// user first, then project overwrites same-named entries ("both" and
		// "user" both start from the user set; "both" additionally overlays).
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
