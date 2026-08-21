/**
 * pi-envoy — runtime configuration and per-process delegation context.
 *
 * Data layout under the data dir (`<agentDir>/subagents` by default):
 *   config.json        merged configuration (optional)
 *   bus/<id>.in.jsonl  per-agent inbox (steering from parents)
 *   bus/<id>.out.jsonl per-agent outbox (checkpoints to parent)
 *   bus/main.jsonl     outermost agent's inbox
 *   bus/groups/<g>.jsonl  shared group channel
 *   ledger.jsonl       append-only audit/reputation ledger (§4.6/§4.8)
 *   worktrees/         git worktrees for isolated children (§4.7)
 *   tmp/               contract files
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ParentContext, PluginConfig } from "./types.ts";

const ENV_PREFIX = "PI_ENVOY_";

const DEFAULT_CONFIG: PluginConfig = {
	maxConcurrent: 4,
	maxDepth: 4,
	keepWorktreeOn: ["failed", "cancelled", "timeout"],
	cleanupBusAfterDays: 7,
	allowVerify: true,
	defaultReportCadence: "on-checkpoint",
	defaultWorktree: false,
	killChildrenOnShutdown: true,
	keepRunningChildrenWorktrees: true,
	pushInterject: true,
};

/** Test seam — overrides getDataDir(). */
let dataDirOverride: string | null = null;

export function setDataDirForTests(dir: string): void {
	dataDirOverride = dir;
}

export function getDataDir(): string {
	if (dataDirOverride) return dataDirOverride;
	return path.join(getAgentDir(), "envoy");
}

/** Load merged config: defaults < config.json < PI_ENVOY_* env. */
export function readConfig(dataDir: string): PluginConfig {
	const config: PluginConfig = { ...DEFAULT_CONFIG };

	const configPath = path.join(dataDir, "config.json");
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<PluginConfig>;
		Object.assign(config, raw);
	} catch {
		// no config file — defaults
	}

	const num = (key: string): number | undefined => {
		const v = process.env[ENV_PREFIX + key];
		if (v === undefined || v === "") return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	};
	const bool = (key: string): boolean | undefined => {
		const v = process.env[ENV_PREFIX + key];
		if (v === undefined || v === "") return undefined;
		return v === "1" || v.toLowerCase() === "true";
	};

	if (num("MAXCONCURRENT") !== undefined) config.maxConcurrent = num("MAXCONCURRENT")!;
	if (num("MAXDEPTH") !== undefined) config.maxDepth = num("MAXDEPTH")!;
	if (bool("ALLOWVERIFY") !== undefined) config.allowVerify = bool("ALLOWVERIFY")!;
	if (bool("KILLONSHUTDOWN") !== undefined) config.killChildrenOnShutdown = bool("KILLONSHUTDOWN")!;
	if (bool("DEFAULTWORKTREE") !== undefined) config.defaultWorktree = bool("DEFAULTWORKTREE")!;
	if (bool("PUSHINTERJECT") !== undefined) config.pushInterject = bool("PUSHINTERJECT")!;

	return config;
}

/**
 * Reconstruct the per-process delegation context from the environment.
 * The outermost agent (main) has no PI_ENVOY_ID and serves as the
 * orchestrator for this lineage.
 */
export function parentContextFromEnv(dataDir: string): ParentContext {
	const env = process.env;
	const id = env.PI_ENVOY_ID ?? null;
	const parentId = env.PI_ENVOY_PARENT_ID ?? null;
	const depth = Number.parseInt(env.PI_ENVOY_DEPTH ?? "0", 10) || 0;
	const maxDepth = Number.parseInt(env.PI_ENVOY_MAXDEPTH ?? String(DEFAULT_CONFIG.maxDepth), 10) || DEFAULT_CONFIG.maxDepth;
	const group = env.PI_ENVOY_GROUP ?? id ?? "main";

	const inbox = id ? path.join(dataDir, "bus", `${id}.in.jsonl`) : path.join(dataDir, "bus", "main.jsonl");
	const mainInbox = env.PI_ENVOY_MAIN_INBOX ?? path.join(dataDir, "bus", "main.jsonl");

	return { id, parentId, group, depth, dataDir, inbox, mainInbox, maxDepth };
}

/** Environment block passed to a spawned child so its own plugin instance is wired. */
export function buildChildEnv(ctx: ParentContext, childId: string, group: string): Record<string, string> {
	return {
		PI_ENVOY_ID: childId,
		PI_ENVOY_PARENT_ID: ctx.id ?? "main",
		PI_ENVOY_GROUP: group,
		PI_ENVOY_DEPTH: String(ctx.depth + 1),
		PI_ENVOY_DATA_DIR: ctx.dataDir,
		PI_ENVOY_MAIN_INBOX: ctx.mainInbox,
		PI_ENVOY_MAXDEPTH: String(ctx.maxDepth),
	};
}
