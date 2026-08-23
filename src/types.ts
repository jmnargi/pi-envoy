/**
 * pi-envoy — shared types and module contracts.
 *
 * This file is the single source of truth for cross-module APIs. All
 * implementation modules import their types from here and MUST implement the
 * exported function signatures declared in the "Module contracts" section
 * below. Keep signatures stable; if you must change one, update this file and
 * re-check the other modules and src/index.ts wiring.
 *
 * Design model: "Intelligent AI Delegation" (Tomašev, Franklin, Osindero,
 * arXiv:2602.11865). Each design decision maps to a paper section; the
 * mapping lives in README.md §Principles.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

/** Names of the tools registered by this plugin (used for whitelists and recursion). */
export const ENVOY_TOOLS: readonly string[] = [
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

export type { ThinkingLevel };

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

/** Lifecycle state of a delegated subagent (delegatee). */
export type ChildState =
	| "queued"
	| "starting"
	| "running"
	| "done"
	| "failed"
	| "cancelled"
	| "timeout"
	| "verifying";

/** Verbosity/scope of a delegation: atomic = strict spec, open = may decompose (§4.2). */
export type Autonomy = "atomic" | "open";

/** How often the delegatee reports progress (§4.2, §4.5 monitoring cadence). */
export type ReportCadence = "none" | "on-checkpoint" | "turn";

/** Token/usage accounting aggregated per subagent run. */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
	durationMs: number;
}

/**
 * The delegated task contract (§4.1 contract-first decomposition, §4.2 role
 * & boundary specification). Explicit roles, boundaries, verifiability and
 * monitoring cadence are negotiated at spawn time.
 */
export interface TaskSpec {
	/** Agent profile name (agents/*.md frontmatter `name`); empty/omitted uses the built-in task agent. */
	agent: string;
	/** Human-readable name for this subagent, shown in the UI instead of the bare id. */
	name?: string;
	/** The objective. Clarity of intent (§2.1). */
	objective: string;
	/** Acceptance criteria the delegatee must satisfy (§4.1 verifiability). */
	acceptance?: string[];
	/** Shell command run after completion to verify the outcome (§4.8). */
	verify?: string;
	/** Working directory override (an existing path or a worktree path). */
	cwd?: string;
	/** Tool whitelist — delegatee may use only these tools (§4.7 privilege attenuation). */
	tools?: string[];
	/** Explicit tool exclusions. */
	excludeTools?: string[];
	/** Force a read-only toolset (read/grep/find/ls/glob); cannot spawn children. */
	readOnly?: boolean;
	/** Allow the bash tool (default true unless readOnly). */
	allowBash?: boolean;
	/** atomic (default) or open (may recursively sub-delegate, §4.2 recursion). */
	autonomy?: Autonomy;
	/** Model pattern (provider/id or bare id); omitted inherits the parent's model. */
	model?: string;
	/** Extended-thinking level; only honored when the model is inherited. */
	thinking?: ThinkingLevel;
	/** Hard deadline in ms; on expiry the child is terminated (§4.4 adaptive execution). */
	timeoutMs?: number;
	/** Progress-reporting cadence (§4.2/§4.5). Default from config. */
	reportCadence?: ReportCadence;
	/** Create/use an isolated git worktree for this child (§4.7 boundaries). */
	worktree?: boolean;
	/** Optional branch name for the worktree (sanitized). */
	branch?: string;
	/** Keep the worktree on failure/cancel/timeout (default from config). */
	keepWorktreeOnFailure?: boolean;
	/** After success, merge the child branch back into the main branch. */
	mergeBack?: boolean;
	/** Advisory max cost in USD, rendered into the contract (§4.3). */
	maxCostUsd?: number;
	/** Message-bus group id for inter-subagent communication channel. */
	group?: string;
	/** Optional labels for bookkeeping. */
	labels?: string[];
	/** Inherit repo context files (AGENTS.md etc.) in the child (default true). */
	inheritContext?: boolean;
	/** Enforce child extension tools availability for recursion (computed). */
	allowSpawn?: boolean;
}

/** Full result of a finished child run (§4.8 verifiable task completion). */
export interface ChildResult {
	id: string;
	agent: string;
	/** Human-readable name shown in the UI (spec.name, falls back to agent). */
	name: string;
	state: ChildState;
	/** Who/what terminated the child: "cancelled" (user) | "shutdown" | "timeout" | null (ran to completion). */
	killReason?: "cancelled" | "shutdown" | "timeout" | null;
	exitCode: number | null;
	stopReason?: string;
	error?: string;
	usage: Usage;
	summary: string;
	/** Signed-style attestation record (§4.8). */
	attestation: Attestation;
	/** Verification result (§4.8). */
	verify: VerifyResult | null;
	/** Worktree info when one was created. */
	worktree?: WorktreeInfo;
	durationMs: number;
	startedAt: number;
	endedAt: number;
}

/** §4.8 Verifiable task completion — recursive attestation chain. */
export interface Attestation {
	taskId: string;
	agent: string;
	outcome: "verified" | "unverified" | "failed" | "cancelled" | "timeout";
	verify: VerifyResult | null;
	/// Delegatee's self-report of acceptance-criteria satisfaction.
	acceptance: boolean | null;
	/** Transitive attestations of children (§4.8 recursion, §4.5 topology). */
	children: AttestationChild[];
	/** One-paragraph summary produced by the delegatee. */
	summary: string;
}

export interface AttestationChild {
	id: string;
	agent: string;
	outcome: string;
	summary: string;
}

export interface VerifyResult {
	command: string;
	exitCode: number | null;
	output: string;
}

// ---------------------------------------------------------------------------
// Message bus (§4.5 monitoring; inter-agent communication)
// ---------------------------------------------------------------------------

export type BusMessageKind =
	| "progress"
	| "checkpoint"
	| "question"
	| "steer"
	| "reply"
	| "escalation"
	| "announcement"
	| "result";

/** A message on the file-based bus. `to` is an agent id, "parent", "group", or "main". */
export interface BusMessage {
	ts: number;
	from: string;
	to: string;
	kind: BusMessageKind;
	text: string;
	data?: Record<string, unknown>;
}

/** Per-process delegation context derived from env (see config.ts). */
export interface ParentContext {
	/** This process's own agent id; null when this is the outermost (main) agent. */
	id: string | null;
	/** The id of the process that spawned us, if any. */
	parentId: string | null;
	/** Bus group shared by a family of related subagents. */
	group: string;
	/** Recursion depth; the main agent is depth 0. */
	depth: number;
	/** Directory holding bus files, ledger, config (`<agentDir>/subagents`). */
	dataDir: string;
	/** Path of this process's inbox file ("main" when main agent). */
	inbox: string;
	/** Path of the outermost agent's inbox. */
	mainInbox: string;
	/** Maximum recursion depth (§2.3 span of control). */
	maxDepth: number;
}

// ---------------------------------------------------------------------------
// Reputation ledger (§4.6)
// ---------------------------------------------------------------------------

export interface ReputationSummary {
	agent: string;
	runs: number;
	successes: number;
	failures: number;
	successRate: number;
	medianDurationMs: number | null;
	totalCostUsd: number;
	lastOutcome: string | null;
}

// ---------------------------------------------------------------------------
// Worktrees (§4.7 boundaries)
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
	path: string;
	branch: string;
	repoRoot: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PluginConfig {
	/** Max concurrently running children per process (§2.3 span of control). */
	maxConcurrent: number;
	/** Max recursion depth (§4.2 recursion). */
	maxDepth: number;
	/** States for which the child worktree is kept after the run (§4.8). */
	keepWorktreeOn: ChildState[];
	/** Bus/ledger files older than N days are pruned by subagent_cleanup. */
	cleanupBusAfterDays: number;
	/** Run `verify` commands submitted by the parent agent (dangerous: arbitrary shell). */
	allowVerify: boolean;
	/** Default report cadence when the spec does not specify one. */
	defaultReportCadence: ReportCadence;
	/** Default worktree isolation for spawned children. */
	defaultWorktree: boolean;
	/** Kill running children on session_shutdown. */
	killChildrenOnShutdown: boolean;
	/** Suppress worktree auto-cleanup while children run (safety). */
	keepRunningChildrenWorktrees: boolean;
	/** Interject inbox messages into the agent as turn-triggering custom messages (no polling). */
	pushInterject: boolean;
}

// ---------------------------------------------------------------------------
// Module contracts
// ---------------------------------------------------------------------------
//
// Implement the following exported functions in the named modules. Do not
// rename or reshuffle them without updating this file and src/index.ts.

/** src/config.ts */
export interface ConfigModule {
	/** Absolute data dir: `<agentDir>/subagents` by default. */
	getDataDir(): string;
	/** Test seam: override the data dir (no-op for real runs). */
	setDataDirForTests(dir: string): void;
	/** Load merged config: defaults < config.json < PI_ENVOY_* env. */
	readConfig(dataDir: string): PluginConfig;
	/** Build the ParentContext for this process from env + data dir. */
	parentContextFromEnv(dataDir: string): ParentContext;
	/** Env block passed to a spawned child. */
	buildChildEnv(ctx: ParentContext, childId: string, group: string): Record<string, string>;
}

/** src/bus.ts */
export interface BusModule {
	inboxPath(dataDir: string, id: string): string;
	mainInboxPath(dataDir: string): string;
	groupPath(dataDir: string, group: string): string;
	/** Append one message to a bus file (creates parent dirs). */
	postMessage(file: string, msg: BusMessage): Promise<void>;
	/** Read messages from a bus file newer than `sinceMs` (default: all). */
	readMessages(file: string, sinceMs?: number): Promise<BusMessage[]>;
	/** Resolve a `to` address ("main"|"parent"|"group"|<id>) to a file path. */
	resolveAddress(ctx: ParentContext, to: string): string;
}

/** src/ledger.ts */
export interface LedgerModule {
	ledgerPath(dataDir: string): string;
	/** Append a completed run to the immutable-style audit ledger (§4.6/§4.8). */
	appendOutcome(dataDir: string, attestation: Attestation, usage: Usage): Promise<void>;
	/** Aggregate reputation for one agent, or all agents when omitted. */
	reputation(dataDir: string, agent?: string): Promise<ReputationSummary[]>;
	/** All ledger entries (newest first). */
	listLedger(dataDir: string): Promise<unknown[]>;
}

/** src/worktrees.ts */
export interface WorktreeModule {
	/** Create a detached worktree on a fresh `subagent/<id>` branch. */
	createWorktree(dataDir: string, repoDir: string, id: string, branch?: string): Promise<WorktreeInfo>;
	/** List worktrees of a repo (`git worktree list --porcelain`). */
	listWorktrees(repoDir: string): Promise<WorktreeInfo[]>;
	/** Remove a worktree; keep-on-failure respected via `keep`. */
	removeWorktree(dataDir: string, repoDir: string, path: string, opts: { keep?: boolean }): Promise<void>;
	/** Merge the child branch into the main branch of `repoDir`. */
	mergeBack(repoDir: string, branch: string, opts: { cwd: string }): Promise<{ ok: boolean; output: string; conflicted: boolean }>;
	/** `git worktree prune` after removals. */
	prune(repoDir: string): Promise<void>;
}

/** src/contract.ts */
export interface ContractModule {
	/** Render the delegation contract markdown (§4.1/§4.2/§4.8). */
	buildContractText(args: {
		spec: TaskSpec;
		profile: AgentProfile;
		ctx: ParentContext;
		inbox: string;
		outbox: string;
		groupChannel: string;
		childId: string;
		maxCostUsd?: number;
	}): string;
	/** Write the contract to a temp file; returns the path (caller deletes). */
	writeContractFile(dataDir: string, childId: string, text: string): Promise<string>;
	/** Run a verification command in `cwd` with a timeout (§4.8). */
	runVerify(command: string, cwd: string, timeoutMs?: number): Promise<VerifyResult>;
}

/** src/spawn.ts */
export interface SpawnModule {
	/** Build the pi CLI argv for a child run. */
	buildPiArgs(args: { spec: TaskSpec; contractFile: string; taskText: string }): string[];
	/**
	 * Spawn a background child `pi` process. The runner resolves `wait()`
	 * when the process exits; `kill()` terminates it. `onMessage` receives
	 * parsed JSON-lines events (message_end / tool_result_end).
	 */
	spawnChild(args: {
		id: string;
		spec: TaskSpec;
		ctx: ParentContext;
		cwd: string;
		contractFile: string;
		commandOverride?: { command: string; args: string[] };
		onMessage?: (event: unknown) => void;
		onExit?: (code: number | null) => void;
		timeoutMs?: number;
	}): {
		id: string;
		wait(): Promise<{ exitCode: number | null; stderr: string }>;
		kill(reason: string): void;
		pid: number | null;
	};
}

/** src/agents.ts — agent profiles (agents/*.md with YAML frontmatter). */
export type AgentScope = "user" | "project" | "both";

export interface AgentProfile {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentProfile[];
	projectAgentsDir: string | null;
}

export const DEFAULT_AGENT = "task";

/** src/agents.ts */
export interface AgentsModule {
	discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult;
}

// Re-export the module implementations' types for the wiring layer.
export interface SubagentsEnv {
	dataDir: string;
	config: PluginConfig;
	ctx: ParentContext;
	agents: AgentProfile[];
}
