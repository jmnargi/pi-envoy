# pi-envoy

Intelligent subagent delegation for the **pi coding agent** (this is a plugin for
[pi](https://github.com/earendil-works/pi) — the `@earendil-works/pi-coding-agent`
CLI — **not** OMP).

`pi-envoy` turns pi into an orchestrator that can delegate work to isolated
child `pi` processes with the properties you expect from a serious subagent
system:

- **background spawn** — start a subagent, get an id, keep working;
- **wait on one** — `subagent_wait` blocks until a specific child settles;
- **message in/out** — steer a running child, read its live progress reports;
- **recursive subagents** — a child may itself spawn children, to a bounded depth;
- **git worktree isolation** — parallel children edit separate worktrees;
- **inter-subagent & main-agent communication** — a file-based bus with
  main / parent / group / peer addressing.

The design follows the delegation framework of
[Tomašev, Franklin & Osindero, *Intelligent AI Delegation*,
arXiv:2602.11865](https://arxiv.org/abs/2602.11865). The mapping of paper sections to
plugin features is in [Principles](#principles-paper-mapping).

**Status:** typechecked (`tsc --noEmit`), unit-tested (`bun test`, 44 tests), and
**validated end-to-end against a real `pi` binary**: a live `pi` session loaded
the extension, called `subagent_spawn`, spawned a real child `pi` process
(isolated HOME + a local OpenAI-compatible stub as the provider), and returned a
`verified` outcome with usage and attestation written to the ledger. See
[Validation](#validation).

---

## Install

The extension is a plain TypeScript module with a `pi.extensions` manifest
(`package.json`). Install it however you install pi extensions:

**Option A — copy into the auto-discovery directory**

```bash
mkdir -p ~/.pi/agent/extensions/pi-envoy
cp -r src agents package.json tsconfig.json ~/.pi/agent/extensions/pi-envoy/
cd ~/.pi/agent/extensions/pi-envoy && npm install   # resolves "typebox"
```

Then start pi (or `/reload` in an interactive session). You should see
`pi-envoy ready (depth 0)` on `session_start`.

**Option B — one-off with a CLI flag**

```bash
pi -e /path/to/pi-envoy/src/index.ts
```

**Option C — package distribution**

```bash
pi install npm:<pkg>   # or: pi install git:github.com/<you>/pi-envoy
```

> **Security:** extensions run with your full system permissions and can
> execute arbitrary code ([pi docs](https://pi.dev/docs/latest/extensions)).
> Only install from sources you trust. The same is true for each subagent this
> plugin spawns — see [Security model](#security-model).

After install, register sample agent profiles:

```bash
mkdir -p ~/.pi/agent/agents
cp agents/*.md ~/.pi/agent/agents/
```

## Quick start

In a pi session, ask the model to delegate:

```
Use subagent_spawn to have the worker agent list all TODO markers in this repo
and propose a cleanup plan.
```

The model will call `subagent_spawn`, then `subagent_wait`, and report the
child's summary, usage and verification result. To watch a long-running child:

```
Start subagent_xyz in the background and tell me when it's done.
```

which yields `subagent_spawn { wait: false }` → `subagent_wait { ids: [...] }`.

## Tools

| Tool | Purpose |
|------|---------|
| `subagent_spawn` | Delegate a task to a child `pi` process with a formal contract. Returns an id; `wait: true` blocks and returns the full result. |
| `subagent_wait` | **The wait-on-one primitive.** Blocks until the listed children settle (or the timeout fires); `all: false` returns on the first to settle. |
| `subagent_status` | Registry summary, or one child's full record (use `all: false`-style polling). |
| `subagent_messages` | Read the bus: a child's OUTBOX (progress/checkpoints) or your own inbox (steering/questions). Optional `since` (epoch ms) and `kind` filters. |
| `subagent_send` | Deliver a message to a child's inbox (the child is instructed to read it at the start of every work step). |
| `subagent_post` | Broadcast to the bus: `main`, `parent`, or the shared `group` channel — inter-subagent and parent/child communication. |
| `subagent_reputation` | Aggregate per-agent outcomes from the audit ledger (success rate, median duration, cost). |
| `subagent_cancel` | Terminate a running/queued child (SIGTERM → SIGKILL), respecting worktree-keep policy. |
| `subagent_cleanup` | Remove finished worktrees, delete contract temp files, prune old bus files (never the ledger). |
Commands: `/envoy` (status table), `/envoy-cleanup` (prune).

## Validation

The plugin was validated end-to-end against the real `pi` CLI (v0.84.2) with a
local OpenAI-compatible stub standing in for an LLM provider:

1. `test/fixtures/stub-openai.mjs` is an SSE chat-completions stub whose reply
   logic is deterministic: the main session's first turn is answered with a
   `subagent_spawn` tool call (`worker`, `wait: true`, `verify: test ...`);
   any request carrying the delegation contract is answered with `OK` (the
   child); a turn containing a `tool` result is answered with a final summary.
2. Register a local provider fixture (`pi.registerProvider("stub", ...)` with
   `baseUrl: http://127.0.0.1:8787/v1`, `api: "openai-completions"`) in the
   agent dir, copy `src/*.ts` to `~/.pi/agent/extensions/pi-envoy/index.ts`
   (flat, so auto-discovery finds it) and `agents/*.md` to `~/.pi/agent/agents/`.
3. `pi --mode json -p "Use the subagent tools." --no-session --model stub-chat`
   produced the real chain: extension load → `subagent_spawn` execution →
   child `pi` process (818 ms, 1 turn, exit 0) → `verify` passed → outcome
   `verified` with usage and attestation appended to `ledger.jsonl`.

Outside the stub run, worktree isolation, merging, bus messaging, contracts and the
ledger are covered by the hermetic test suite. What the stub run does **not**
exercise: a real provider (no API keys were used), interactive TUI rendering,
and bus traffic between live children (unit-tested only).

## How a subagent runs

```
parent pi process (this extension)
   │  subagent_spawn
   │    ├─ resolve agent profile (agents/*.md frontmatter)
   │    ├─ [worktree]  git worktree add -b subagent/<id> <dataDir>/worktrees/<repo>-<id>
   │    ├─ contract    delegation contract ⇢ tmp/contract-<id>.md
   │    ├─ spawn       pi --mode json -p --no-session [--model|--thinking] [--tools …]
   │    │              --append-system-prompt <contract>  Task: <objective>
   │    └─ env         PI_ENVOY_ID / _PARENT_ID / _GROUP / _DEPTH / _DATA_DIR / …
   │
   │  child streams stdout JSON-lines events (message_end, tool_result_end)
   │  ⇢ usage accumulation, stopReason, final text
   │
   ├─ bus files       parents ⇢ <id>.in.jsonl   children ⇢ <id>.out.jsonl
   │                  main ⇢ main.jsonl         group ⇢ groups/<group>.jsonl
   │
   ├─ verify          run <verify> in the child's cwd (if requested & allowed)
   ├─ attestation     outcome, verify result, SUMMARY/SELF_REPORT/CHILDREN,
   │                  transitive child attestations (§4.8)
   ├─ ledger          append outcome (reputation history, §4.6)
   └─ worktree        merged back / kept (failure) / removed + pruned
```

Children are ordinary `pi` processes that load this same extension from the
auto-discovery directory, so **recursion is automatic** — a child may call
`subagent_spawn` itself up to `maxDepth` (default 4). Each process in the tree
is wired to the shared bus through `PI_ENVOY_*` environment variables.

## The delegation contract

Every task is formalized before execution (the paper's *contract-first
decomposition*, §4.1, and *role & boundary specification*, §4.2). The contract
is appended to the child's system prompt via `--append-system-prompt` and
contains:

- **Objective** — the verbatim goal (clarity of intent, §2.1);
- **Scope and boundaries** — cwd, allowed tools, read-only status, worktree
  note, and the recursion policy (atomic children may not spawn; open children
  may, to bounded depth);
- **Acceptance criteria** — when given, plus the required closing block:
  `SUMMARY: <one paragraph>` / `SELF_REPORT: pass|fail` /
  `CHILDREN: <id agent outcome summary>` lines;
- **Verification** — the `verify` command the delegator will run afterwards (§4.8);
- **Reporting** — cadence (`none` / `on-checkpoint` / `turn`), the exact
  `echo '{"ts":…,"from":…,"to":"parent","kind":"checkpoint","text":"…"}' >> OUTBOX`
  template, inbox-polling instructions, and the group/main channel paths (§4.2/§4.5);
- **Budget and deadline** — optional hard timeout and advisory cost (§4.3, §4.4).

## Data layout

<agentDir>/envoy/              # getAgentDir() + "envoy"
  config.json                    # optional config (see below)
  bus/
    <id>.in.jsonl                # per-agent inbox (steering)
    <id>.out.jsonl               # per-agent outbox (checkpoints → parent)
    main.jsonl                   # outermost agent's inbox
    groups/<group>.jsonl         # shared group channel
  ledger.jsonl                   # append-only audit/reputation ledger
  worktrees/<repo>-<id>/         # git worktrees (isolated children)
  tmp/contract-<id>.md           # rendered contracts
```

## Configuration

`config.json` in the data dir (all keys optional), or `PI_ENVOY_*` env:

| Key / env | Default | Meaning |
|---|---|---|
| `maxConcurrent` / `PI_ENVOY_MAXCONCURRENT` | 4 | Running children per process (span of control, §2.3) |
| `maxDepth` / `PI_ENVOY_MAXDEPTH` | 4 | Recursion depth limit (§4.2) |
| `keepWorktreeOn` | `["failed","cancelled","timeout"]` | States after which the child worktree is kept for inspection |
| `cleanupBusAfterDays` | 7 | Bus files older than this are pruned by `subagent_cleanup` |
| `allowVerify` / `PI_ENVOY_ALLOWVERIFY` | true | Permit running `verify` shell commands (dangerous: arbitrary shell) |
| `defaultReportCadence` | `on-checkpoint` | Contract reporting cadence when unspecified |
| `defaultWorktree` / `PI_ENVOY_DEFAULTWORKTREE` | false | Isolate every child in a worktree by default |
| `killChildrenOnShutdown` / `PI_ENVOY_KILLONSHUTDOWN` | true | Terminate running children on `session_shutdown` |
| `keepRunningChildrenWorktrees` | true | Never auto-remove worktrees while children run |
| `PI_ENVOY_DISABLED` | unset | `"1"` disables the extension entirely |

## Agent profiles

Agents are markdown files with YAML frontmatter, discovered from
`~/.pi/agent/agents/*.md`:

```markdown
---
name: reviewer
description: Code review
tools: read, grep, glob, find, ls, bash
model: claude-sonnet-4-5
---

System prompt for the agent lives here.
```

- `name` (defaults to the filename), `description`, `tools` (comma-list or YAML
  list), `model` (omit to inherit the parent's model/thinking), body = system prompt.
- **User-scope only in v1**: project agents (`.pi/agents/*.md`) are deliberately
  not loaded, so a child of an untrusted repo can never inherit repo-controlled
  system prompts. `discoverAgents(cwd, "both")` exists in `src/agents.ts` for
  explicit opt-in by a future version.
- Built-in samples: `scout` (recon), `planner` (plans), `worker`
  (general-purpose, full tools — the default), `reviewer` (code review).

## Security model

pi has **no sandbox**: everything runs with the permissions of the process
that launched it ([pi docs](packages/coding-agent/docs/containerization.md)).
`pi-envoy` narrows the blast radius of delegation rather than eliminating it:

- **Privilege attenuation (§4.7):** children get explicit tool whitelists
  (`--tools`), `--exclude-tools bash` when requested, and read-only tool sets for
  `readOnly` children; open/atomic autonomy is bounded by `maxDepth`;
  read-only children may never spawn.
- **Worktree isolation:** concurrent children edit separate git worktrees, so
  they cannot clobber each other's files; failure worktrees are kept for
  inspection (never auto-deleted while running).
- **Verify gating:** `verify` commands are arbitrary shell, run in the child's
  cwd, only for children that reached `done`, and only when `allowVerify` is
  enabled — the configurable `PI_ENVOY_ALLOWVERIFY=0` default-off switch
  exists for sensitive environments.
- **No credential inheritance beyond env:** children inherit your environment
  (including provider keys) because that is how pi itself resolves auth; the
  contract tells children never to print secrets to the bus, and the bus is
  local plaintext files — don't put secrets in messages.
- **Threat awareness (§4.9):** a child that has been prompt-injected can
  post forged checkpoint/result messages; treat child output as untrusted data
  (this is why `verify` exists). Worktree branch content is ordinary git data —
  review before merging `subagent/*` branches.

## Principles (paper mapping)

| Paper pillar / section | Framework requirement | Plugin feature |
|---|---|---|
| §2.1, §4.1 contract-first | Clarity of intent, roles, verifiability a priori | Delegation contract: objective, acceptance, verify command, scope, cadence |
| §4.2 task assignment | Roles, boundaries, autonomy level, recursion | Agent profiles, tool whitelists, `autonomy: atomic/open`, bounded recursion |
| §2.3 span of control | Don't over-manage | `maxConcurrent` cap + FIFO queue + `maxDepth` |
| §4.3 multi-objective | Cost/latency/quality trade-offs | `maxCostUsd` advisory budget, model/thinking selection, timeout |
| §4.4 adaptive execution | Handle failure, escalate, complexity floor | Timeouts → terminate; `subagent_cancel`; tool descriptions warn about delegation overhead; retry via re-spawn is left to the model with ledger history |
| §4.5 monitoring | Direct/indirect, outcome/process, event stream | Bus checkpoints (`TASK_STARTED`/`CHECKPOINT_REACHED`/`TASK_COMPLETED` equivalents), `subagent_messages`, status/usage tracking |
| §4.6 trust & reputation | Public verifiable history | Append-only `ledger.jsonl`, `subagent_reputation` aggregation |
| §4.7 permission handling | Privilege attenuation, bounded scopes | Tool whitelists, read-only mode, no-bash, worktree isolation, verify gating, recursion caps |
| §4.8 verifiable completion | Recursive attestation chains | `verify` runs, outcome taxonomy (verified/unverified/failed/…), `CHILDREN` transitive attestations in the ledger |
| §4.9 security | Malicious delegatee/delegator awareness | Worktree isolation, read-only agents, verify trust, no sandbox claims (documented) |

## Development

```bash
npm install && npm i -D @types/bun
npx tsc --noEmit      # strict typecheck
bun test              # 44 unit tests (bus, ledger, contract, worktrees, spawn)
```

Tests use hermetic fakes (a `fake-pi` child emitting JSON-lines events; real
`git` in temp repos for worktree cases) — no pi install or API keys needed.

## Limitations

- **Validated end-to-end against a real `pi` binary** with a local stub
  provider (see [Validation](#validation)); a live run with your own provider
  credentials is still recommended before trusting the plugin with real work.
- The E2E run did not exercise live inter-child bus traffic or TUI rendering;
  those paths are unit-tested only.
- Children are spawned with `--mode json -p --no-session`: they have no
  interactive UI, and their context files/skills follow pi defaults
  (`inheritContext: false` opts out of repo context files).
- The bus is a plaintext JSONL file protocol; no message authentication
  (a malicious child can forge messages to its parent's inbox).
- Attestations are self-reported (`SUMMARY`/`SELF_REPORT`/`CHILDREN` parsed from
  the final message); there is no cryptographic signing (§4.8's signed
  credentials are out of scope for v1).
- `runVerify` executes arbitrary shell commands — keep `allowVerify` off in
  untrusted setups.
- Worktree merge attempts `git merge --no-edit` from the main checkout;
  conflicts are reported and left un-resolved for the model to handle.

## License

MIT.
