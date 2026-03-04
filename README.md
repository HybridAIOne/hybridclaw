# HybridClaw

<img width="540" height="511" alt="image" src="docs/hero.png" />

Personal AI assistant bot for Discord, powered by [HybridAI](https://hybridai.one).

## Install from npm

```bash
npm install -g @hybridaione/hybridclaw
hybridclaw onboarding
```

Latest release: [v0.2.5](https://github.com/HybridAIOne/hybridclaw/releases/tag/v0.2.5)

## What's new (Unreleased)

- Added canonical cross-channel memory sessions (`agent_id + user_id`) with compacted summaries and recent-message recall
- Added usage aggregation storage/query layer (`usage_events`) with daily/monthly totals and by-agent/by-model breakdowns
- Added gateway usage commands: `usage`, `usage daily`, `usage monthly`, `usage model [daily|monthly] [agentId]`
- Added JSONL session export command: `export session [sessionId]`
- Added automatic JSONL export snapshots after session compaction for debugging
- Added schema migration versioning for canonical + usage tables, with WAL + `busy_timeout` at DB init

## What's new in v0.2.5

- Added trusted-coworker approval controls with `yes`, `yes for session`, `yes for agent`, and `skip` flows for red-tier actions
- Added TUI approval menu shortcuts (`1/2/3/4`) and request-id aware approval replies
- Added agent-scoped approval trust persistence in `.hybridclaw/approval-trust.json`
- Moved approval policy path from `.claude/policy.yaml` to `.hybridclaw/policy.yaml`
- Updated yellow-tier implicit approval window to 5s
- Added CI enforcement for changed-file Biome checks plus root/container TypeScript lint before unit tests

## What's new in v0.2.3

- Added Discord guild channel policy controls with typed config: `discord.groupPolicy`, `discord.freeResponseChannels`, and `discord.guilds.<guildId>.channels.<channelId>.mode`
- Added `/channel-mode` and `/channel-policy` slash commands for in-channel Discord policy/mode control
- Added `!claw channel mode` and `!claw channel policy` command flows for in-chat policy changes
- Enforced channel mode/policy in Discord trigger logic while keeping prefixed commands available
- Clarified trigger precedence so per-guild/per-channel mode rules win over global `respondToAllMessages`
- Updated status/activation labeling to reflect allowlist/disabled/mixed channel policy modes

## What's new in v0.2.4

- Added dynamic Discord self-presence health states (`online`/`idle`/`dnd`) with maintenance shutdown presence (`invisible`)
- Added config-backed proactive scheduler jobs via `scheduler.jobs[]` with `cron|every|at` schedules, `agent_turn|system_event` actions, and `channel|last-channel|webhook` delivery targets
- Added atomic scheduler state persistence in `data/scheduler-jobs-state.json` (last run/status, consecutive errors, one-shot completion, auto-disable flags)
- Added humanized Discord pacing behaviors: time-of-day/weekend slowdown, conversation cooldown scaling after long back-and-forth, and reconnect startup staggering
- Added selective silence in active group channels when peers likely already answered
- Added read-without-reply handling for short acknowledgments (react instead of full reply)

## HybridAI Advantage

- Security-focused foundation
- Enterprise-ready stack
- EU-stack compatibility
- GDPR-aligned posture
- RAG-powered retrieval
- Document-grounded responses

## Architecture

- **Gateway service** (Node.js) — shared message/command handlers, SQLite persistence, scheduler, heartbeat, web/API, and optional Discord integration
- **TUI client** — thin client over HTTP (`/api/chat`, `/api/command`)
- **Container** (Docker, ephemeral) — HybridAI API client, sandboxed tool executor, and preinstalled browser automation runtime
- Communication via file-based IPC (input.json / output.json)

## Quick start

```bash
# Install dependencies (this also installs container deps via postinstall)
npm install

# Run onboarding (also auto-runs on first `gateway`/`tui` start if API key is missing)
# On first run, it creates `.env` from `.env.example` automatically if needed.
hybridclaw onboarding

# Onboarding flow:
# 1) explicitly accept TRUST_MODEL.md (required)
# 2) choose whether to create a new account
# 3) open /register in browser (optional) and confirm in terminal
# 4) open /login?next=/admin_api_keys in browser and get an API key
# 5) paste API key (or URL containing it) back into the CLI
# 6) choose the default bot (saved to config.json) and save secrets to `.env`

# Start gateway backend (default)
hybridclaw gateway

# Or run gateway in foreground in this terminal
hybridclaw gateway start --foreground

# If DISCORD_TOKEN is set, gateway auto-connects to Discord.

# Start terminal adapter (optional, in a second terminal)
hybridclaw tui

# Web chat UI (built into gateway)
# open http://127.0.0.1:9090/chat
```

Runtime model:

- `hybridclaw gateway` is the core process and should run first.
- If `DISCORD_TOKEN` is set, Discord runs inside gateway automatically.
- `hybridclaw tui` is a thin client that connects to the gateway.
- `hybridclaw gateway` and `hybridclaw tui` validate the container image at startup.
- If the image is missing, it is built automatically.
- Default rebuild policy is `if-stale`: when tracked container sources changed since last build, the image is rebuilt automatically.
- Policy override (optional): env `HYBRIDCLAW_CONTAINER_REBUILD=if-stale|always|never`.

HybridClaw best-in-class capabilities:

- explicit trust-model acceptance during onboarding (recorded in `config.json`)
- typed `config.json` runtime settings with defaults, validation, and hot reload
- formal prompt hook orchestration (`bootstrap`, `memory`, `safety`)
- Discord conversational UX: edit-in-place streaming responses, fence-safe chunking beyond Discord's 2000-char limit, phase-aware typing/reactions, adaptive debounce batching, per-user rate limits, health-driven self-presence, reply-chain-aware context, concise attachment-first screenshot replies, and humanized pacing (time-of-day slowdown, cooldown scaling, selective silence, read-without-reply, startup staggering)
- token-efficient context assembly: per-message history truncation, hard history budgets with head/tail preservation, and head/tail truncation for oversized bootstrap files
- runtime self-awareness in prompts: exact HybridClaw version/date, model, and runtime host metadata injected each turn for reliable "what version/model are you?" answers
- proactive runtime layer with active-hours gating, push delegation (`single`/`parallel`/`chain`), depth-aware tool policy, and retry controls
- trusted-coworker approval model for tool execution: Green (`just run`), Yellow (`narrate + 5s interrupt window`), Red (`explicit approval`) with `yes` (once), `yes for session`, `yes for agent`, and `skip` (also `1/2/3/4`) plus pinned-red protections
- structured audit trail: append-only hash-chained wire logs (`data/audit/<session>/wire.jsonl`) with tamper-evident immutability, normalized SQLite audit tables, and verification/search CLI commands
- observability export: incremental `events:batch` forwarding with durable cursor tracking and bot-scoped ingest token lifecycle via `ingest-token:ensure`
- model token telemetry in audit/observability events (`model.usage`) with API usage + deterministic fallback estimates
- gateway lifecycle controls: managed + unmanaged restart/stop flows with graceful shutdown fallback paths
- instruction-integrity approval flow: core instruction docs (`AGENTS.md`, `SECURITY.md`, `TRUST_MODEL.md`) are hash-verified against a local approved baseline before TUI start

## Configuration

HybridClaw uses typed runtime config in `config.json` (auto-created on first run).

- Start from `config.example.json` (reference)
- Runtime watches `config.json` and hot-reloads most settings (model defaults, heartbeat, prompt hooks, limits, etc.)
- `discord.guildMembersIntent` enables richer guild member context and better `@name` mention resolution in replies (requires enabling **Server Members Intent** in Discord Developer Portal)
- `discord.presenceIntent` enables Discord presence events (requires enabling **Presence Intent** in Discord Developer Portal)
- `discord.respondToAllMessages` is a global fallback for open-policy guild channels without explicit mode config (`false` mention-gated, `true` free-response)
- `discord.commandUserId` restricts `!claw <command>` admin commands to a single Discord user ID (all other messages still use normal chat handling)
- `discord.commandsOnly` optional hard mode: if `true`, the bot ignores non-`!claw` messages and only accepts prefixed commands (optionally limited by `discord.commandUserId`)
- `discord.groupPolicy` controls guild channel scope: `open` (default), `allowlist`, or `disabled`
- `discord.freeResponseChannels` is a Hermes-style channel ID list that gets free-response behavior while other channels remain mention-gated
- `discord.humanDelay` controls natural delays between multi-part messages (`off|natural|custom`)
- `discord.typingMode` controls typing indicator lifecycle (`instant|thinking|streaming|never`)
- `discord.presence.*` enables dynamic self-presence health states (healthy/degraded/exhausted mapped to `online|idle|dnd`, plus maintenance `invisible` during shutdown)
- `discord.lifecycleReactions.*` enables phase emoji transitions (`queued|thinking|toolUse|streaming|done|error`)
- approval policy layer is configured via `.hybridclaw/policy.yaml` (`approval.pinned_red`, `workspace_fence`, pending/timeout controls, audit toggles)
- `discord.ackReaction`, `discord.ackReactionScope`, and `discord.removeAckAfterReply` control acknowledgment reaction behavior
- `discord.debounceMs` controls default inbound debounce; channel overrides can tune noisy channels
- `discord.rateLimitPerUser` and `discord.rateLimitExemptRoles` enforce per-user sliding-window limits
- `discord.suppressPatterns` blocks auto-reply triggers for suppression terms (case-insensitive)
- `discord.maxConcurrentPerChannel` limits concurrent in-flight runs per channel
- `discord.guilds.<guildId>.defaultMode` sets that guild's fallback mode in `open` policy (`mention` recommended)
- `discord.guilds.<guildId>.channels.<channelId>.*` supports per-channel mode and behavior overrides (`mode`, `typingMode`, `debounceMs`, `ackReaction*`, `humanDelay`, `rateLimitPerUser`, `suppressPatterns`, `maxConcurrentPerChannel`)
- `scheduler.jobs[]` defines config-backed proactive jobs with `schedule.kind` (`cron|every|at`), `action.kind` (`agent_turn|system_event`), and delivery targets (`channel|last-channel|webhook`)
- Config scheduler job metadata (last status, consecutive errors, one-shot completion) persists atomically in `data/scheduler-jobs-state.json`
- Config scheduler jobs auto-disable after repeated failures (5 consecutive errors) and one-shot jobs retry on a bounded interval until successful
- Built-in Discord humanization behaviors include night/weekend pacing, post-exchange cooldown scaling (after 5+ exchanges, reset after 20 minutes idle), selective silence in active free-mode channels, short-ack read reactions, and reconnect staggered dequeue
- Per-guild/per-channel mode takes precedence over `discord.respondToAllMessages`
- Discord slash commands: `/status`, `/channel-mode <off|mention|free>`, and `/channel-policy <open|allowlist|disabled>` (ephemeral replies)
- `skills.extraDirs` adds additional enterprise/shared skill roots (lowest precedence tier)
- `proactive.*` controls autonomous behavior (`activeHours`, `delegation`, `autoRetry`, `ralph`)
- `proactive.ralph.maxIterations` enables Ralph loop (`0` off, `-1` unlimited, `>0` extra autonomous iterations before forcing completion)
- TUI/Gateway command: `ralph on|off|set <n>|info` (`0` off, `-1` unlimited, `1-64` extra iterations)
- `observability.*` controls push ingest into HybridAI (`events:batch` endpoint, batching, identity metadata)
- Some settings require restart to fully apply (for example HTTP bind host/port)
- Default bot is configured via `hybridai.defaultChatbotId` in `config.json`

Secrets remain in `.env`:

- `HYBRIDAI_API_KEY` (required)
- `DISCORD_TOKEN` (optional)
- `WEB_API_TOKEN` and `GATEWAY_API_TOKEN` (optional API auth hardening)
- observability ingest token is auto-managed via `POST /api/v1/agent-observability/ingest-token:ensure` and cached locally

Trust-model acceptance is stored in `config.json` under `security.*` and is required before runtime starts.

See [TRUST_MODEL.md](./TRUST_MODEL.md) for onboarding acceptance policy and [SECURITY.md](./SECURITY.md) for technical security guidelines.

## Audit Trail

HybridClaw records a forensic audit trail by default:

- append-only per-session wire logs in `data/audit/<session>/wire.jsonl`
- SHA-256 hash chaining (`_prevHash` -> `_hash`) for tamper-evident immutability
- normalized query tables in SQLite (`audit_events`, `approvals`)
- policy denials captured as approval/authorization events (for example blocked commands)

Useful commands:

- `hybridclaw audit recent 50`
- `hybridclaw audit search "tool.call" 50`
- `hybridclaw audit approvals 50 --denied`
- `hybridclaw audit verify <sessionId>`
- `hybridclaw audit instructions`
- `hybridclaw audit instructions --approve`

Instruction approval notes:

- local baseline file: `data/audit/instruction-hashes.json`
- `hybridclaw audit instructions` fails when instruction files differ from the approved baseline
- `hybridclaw audit instructions --approve` updates the local approved baseline
- `hybridclaw tui` performs this check before startup and prompts for approval when files changed
- instruction approval actions are audit logged (`approval.request` / `approval.response`, action `instruction:approve`)

## Observability Push

HybridClaw can forward structured audit records to HybridAI's ingest API:

- endpoint: `POST /api/v1/agent-observability/events:batch`
- source: local `audit_events` table (ordered by `id`)
- transport: bearer ingest token auto-fetched via `POST /api/v1/agent-observability/ingest-token:ensure` using `HYBRIDAI_API_KEY`
- delivery: incremental batches with persisted cursor (`observability_offsets` table), max 1000 events and max 2,000,000-byte payload per request
- token handling: token cache is stored locally in SQLite (`observability_ingest_tokens`) and automatically refreshed on ingest auth failures
- token visibility: `model.usage` payloads include `promptTokens`, `completionTokens`, `totalTokens`, plus estimated and API-native counters for accuracy/coverage

Config keys (in `config.json`):

- `observability.enabled` (`true` by default)
- `observability.baseUrl` (for example `https://hybridai.one`)
- `observability.ingestPath` (`/api/v1/agent-observability/events:batch`)
- `observability.botId` (defaults to `hybridai.defaultChatbotId` when empty)
- `observability.agentId`, `observability.label`, `observability.environment`
- `observability.flushIntervalMs`, `observability.batchMaxEvents`

Runtime diagnostics:

- local status endpoint `GET /api/status` includes an `observability` block (enabled/running/paused, cursor, last success/failure timestamps)

## Agent workspace

Each agent gets a persistent workspace with markdown files that shape its personality and memory:

| File | Purpose |
|------|---------|
| `SOUL.md` | Personality, tone, identity |
| `IDENTITY.md` | Name, avatar, emoji |
| `USER.md` | Info about the human |
| `MEMORY.md` | Persistent memory across sessions |
| `AGENTS.md` | Workspace conventions and rules |
| `TOOLS.md` | Environment-specific notes |
| `HEARTBEAT.md` | Periodic tasks |
| `BOOT.md` | Startup instructions |

Templates in `templates/` are copied to new agent workspaces on first run.
Historical turn logs are mirrored into `<workspace>/.session-transcripts/*.jsonl` for `session_search`.

## Skills

HybridClaw supports `SKILL.md`-based skills (`<skill-name>/SKILL.md`).

### Where to put skills

You can place skills in:

- any directory listed in `config.skills.extraDirs[]` (enterprise/shared)
- bundled package skills (`<hybridclaw install>/skills/<skill-name>/SKILL.md`)
- `$CODEX_HOME/skills/<skill-name>/SKILL.md` or `~/.codex/skills/<skill-name>/SKILL.md`
- `~/.claude/skills/<skill-name>/SKILL.md`
- `~/.agents/skills/<skill-name>/SKILL.md`
- `./.agents/skills/<skill-name>/SKILL.md` (project)
- `./skills/<skill-name>/SKILL.md` (workspace)

Load precedence is:

- `extra < bundled < codex < claude < agents-personal < agents-project < workspace`
- skills are merged by `name`; higher-precedence sources override lower-precedence ones

Security scanning is trust-aware:

- `bundled` sources are treated as `builtin` and not scanned
- `workspace` sources (`./skills/`, `./.agents/skills/`) are scanned; `caution` is allowed, `dangerous` is blocked
- `personal` sources (`~/.codex/skills/`, `~/.claude/skills/`, `~/.agents/skills/`) are scanned and blocked on `caution`/`dangerous`
- scanner includes Hermes-derived regex checks, structural limits (50 files, 1MB total, 256KB/file, binary/symlink checks), invisible-unicode detection, and mtime+content-hash cache reuse

### Required format

Each skill must be a folder with a `SKILL.md` file and frontmatter:

```markdown
---
name: repo-orientation
description: Quickly map an unfamiliar repository and identify where a requested feature should be implemented.
user-invocable: true
disable-model-invocation: false
always: false
requires:
  bins: [docker, git]
  env: [GITHUB_TOKEN]
metadata:
  hybridclaw:
    tags: [devops, docker]
    related_skills: [kubernetes]
---

# Repo Orientation
...instructions...
```

Supported frontmatter keys:

- `name` (required)
- `description` (required)
- `user-invocable` (optional, default `true`)
- `disable-model-invocation` (optional, default `false`)
- `always` (optional, default `false`; embeds full skill body in the system prompt up to `maxAlwaysChars=10000`, then demotes to summary)
- `requires.bins` / `requires.env` (optional; skill is excluded unless requirements are met)
- `metadata.hybridclaw.tags` / `metadata.hybridclaw.related_skills` (optional metadata namespace)

### Using skills

Skills are listed to the model as metadata (`name`, `description`, `location`), and the model reads `SKILL.md` on demand with the `read` tool. Skills with `always: true` are embedded directly in the system prompt.

Prompt embedding modes:

- `Always`: `always: true` embeds full body in `<skill_always ...>` (budgeted by `maxAlwaysChars=10000`)
- `Summary`: default mode, emits only XML metadata under `<available_skills>`
- `Hidden`: `disable-model-invocation: true` excludes the skill from model prompt metadata (still invocable by slash command when `user-invocable: true`)

Explicit invocation is supported via:

- `/skill <name> [input]`
- `/skill:<name> [input]`
- `/<name> [input]` (when `user-invocable: true`; command names are sanitized to lowercase `a-z0-9-`, max 32 chars, with `-2`/`-3` dedup and built-in command-name blocking)

Example skill in this repo:

- `skills/repo-orientation/SKILL.md`
- `skills/current-time/SKILL.md`
- `skills/personality/SKILL.md`
- `skills/skill-creator/SKILL.md`

### Personality switching skill

HybridClaw includes a command-only personality skill that updates the active persona contract in `SOUL.md`.

- List current/available persona: `/personality` (or `/personality list`)
- Activate persona: `/personality <name>`
- Reset to default persona: `/personality reset`

The skill writes/updates a managed block in `SOUL.md`:

- `## Active personality`
- `Name: ...`
- `Definition: ...` (copied from the selected profile in `skills/personality/SKILL.md`)
- `Rules: ...` (runtime style/behavior constraints)

Notes:

- The personality skill is intentionally command-only (`always: false`, `disable-model-invocation: true`) to avoid adding per-turn prompt overhead.
- Profiles are defined in `skills/personality/SKILL.md` and currently include 25 switchable personas (expert, style, and role personas).

## Agent tools

The agent has access to these sandboxed tools inside the container:

- `read` / `write` / `edit` / `delete` — file operations
- `glob` / `grep` — file search
- `bash` — shell command execution
- `memory` — durable memory files (`MEMORY.md`, `USER.md`, `memory/YYYY-MM-DD.md`)
- `session_search` — search/summarize historical sessions from transcript archives
- `delegate` — push-based background subagent tasks (`single`, `parallel`, `chain`) with auto-announced completion (no polling)
- `web_fetch` — plain HTTP fetch + extraction for static/read-only content (docs, articles, READMEs, JSON/text APIs, direct files)
- `browser_*` (optional) — full browser automation for JS-rendered or interactive pages (`navigate`, `snapshot`, `click`, `type`, `press`, `scroll`, `back`, `screenshot`, `pdf`, `close`)

`delegate` mode examples:

- single: `{ "prompt": "Audit auth middleware and list risks", "label": "auth-audit" }`
- parallel: `{ "mode": "parallel", "label": "module-audit", "tasks": [{ "prompt": "Scan api/" }, { "prompt": "Scan ui/" }] }`
- chain: `{ "mode": "chain", "label": "implement-flow", "chain": [{ "prompt": "Scout the payment module" }, { "prompt": "Plan changes from: {previous}" }, { "prompt": "Implement based on: {previous}" }] }`

Browser tooling notes:

- Routing default: prefer `web_fetch` first for read-only retrieval.
- Use browser tools for SPAs/web apps/auth flows/interaction tasks, or when `web_fetch` returns escalation hints (`javascript_required`, `spa_shell_only`, `empty_extraction`, `boilerplate_only`, `bot_blocked`).
- Cost profile: browser calls are typically ~10-100x slower/more expensive than `web_fetch`.
- Browser read flow: after `browser_navigate`, use `browser_snapshot` with `mode="full"` to extract content, then `browser_scroll` + `browser_snapshot` for additional lazy-loaded sections.
- `browser_pdf` is for export artifacts, not text extraction.

- The shipped container image preinstalls `agent-browser` and Chromium (Playwright).
- You can override the binary via `AGENT_BROWSER_BIN` if needed.
- User-directed authenticated browser-flow testing is supported (including filling/submitting login forms on the requested site).
- Browser auth/session state now persists per HybridClaw session by default via a dedicated profile directory under `/workspace/.hybridclaw-runtime/browser-profiles`.
- Session cookies/localStorage are also auto-saved/restored via `agent-browser` session-state files.
- Optional overrides: `BROWSER_PERSIST_PROFILE=false` (disable profile persistence), `BROWSER_PERSIST_SESSION_STATE=false` (disable state file persistence), `BROWSER_PROFILE_ROOT=/path` (custom profile root), `BROWSER_CDP_URL=ws://...` (force CDP attachment to an existing browser).
- Structured audit logs redact sensitive browser/tool arguments (password/token/secret fields and typed form text).
- Navigation to private/loopback hosts is blocked by default (set `BROWSER_ALLOW_PRIVATE_NETWORK=true` to override).
- Screenshot/PDF outputs are constrained to `/workspace/.browser-artifacts`.

HybridClaw also supports automatic session compaction with pre-compaction memory flush:

- when a session gets long, old turns are summarized into `session_summary`
- before compaction, the agent gets a `memory`-only flush turn to persist durable notes
- each `(agent_id, user_id)` pair also maintains a canonical cross-channel session for continuity across channels
- canonical context injection includes compacted summary + recent cross-channel messages (excluding the current live session)
- compaction writes JSONL exports to `<workspace>/.session-exports/` for human-readable debugging

System prompt assembly is handled by a formal hook pipeline:

- `bootstrap` hook (workspace bootstrap + skills metadata)
- `memory` hook (session summary)
- `safety` hook (runtime guardrails / trust-model constraints)
- `proactivity` hook (memory capture, session recall, delegation behavior)

Hook toggles live in `config.json` under `promptHooks`.

## Testing

Run checks locally:

```bash
# Typecheck only (no emit)
npm run typecheck

# Strict TS lint gate (unused locals/params)
npm run lint

# Unit tests (default `npm test`)
npm run test:unit

# Scoped suites (ready for dedicated tests)
npm run test:integration
npm run test:e2e
npm run test:live
```

Test layout and scopes:

- tests live under `tests/` (not `src/`)
- unit tests: `tests/**/*.test.ts` (excluding `*.integration|*.e2e|*.live`)
- integration tests: `tests/**/*.integration.test.ts`
- e2e tests: `tests/**/*.e2e.test.ts`
- live tests: `tests/**/*.live.test.ts`

## Commands

CLI runtime commands:

- `hybridclaw gateway start [--foreground]` — Start gateway (backend by default; foreground with flag)
- `hybridclaw gateway restart [--foreground]` — Restart managed gateway backend process
- `hybridclaw gateway stop` — Stop managed gateway backend process
- `hybridclaw gateway status` — Show lifecycle/API status
- `hybridclaw gateway <command...>` — Send a command to a running gateway (for example `sessions`, `bot info`)
- `hybridclaw tui` — Start terminal client connected to gateway
- `hybridclaw onboarding` — Run HybridAI account/API key onboarding
- `hybridclaw update [status|--check] [--yes]` — Check for updates and upgrade global npm installs (source checkouts get git-based update instructions)
- `hybridclaw audit ...` — Verify and inspect structured audit trail (`recent`, `search`, `approvals`, `verify`, `instructions`)

In Discord, use `!claw help` to see all commands. Key ones:

- `!claw <message>` — Talk to the agent
- `!claw bot set <id>` — Set chatbot for this channel
- `!claw model set <name>` — Set model for this channel
- `!claw rag on/off` — Toggle RAG
- `!claw clear` — Clear conversation history
- `!claw audit recent [n]` — Show recent structured audit events
- `!claw audit verify [sessionId]` — Verify audit hash chain integrity
- `!claw audit search <query>` — Search structured audit history
- `!claw audit approvals [n] [--denied]` — Show policy approval decisions
- `!claw usage [summary|daily|monthly|model [daily|monthly] [agentId]]` — Show token/cost aggregates
- `!claw export session [sessionId]` — Export session snapshot as JSONL
- `!claw schedule add "<cron>" <prompt>` — Add cron scheduled task
- `!claw schedule add at "<ISO time>" <prompt>` — Add one-shot task
- `!claw schedule add every <ms> <prompt>` — Add interval task

## Project structure

```
src/gateway.ts                    Core runtime entrypoint (DB, scheduler, heartbeat, HTTP API)
src/tui.ts                        Terminal adapter (thin client to gateway)
src/channels/discord/runtime.ts   Discord runtime integration and message transport
src/channels/discord/*.ts         Discord responsibility modules (inbound, delivery, mentions, attachments, tools, stream)
src/gateway-service.ts            Core shared agent/session logic used by gateway API
src/gateway-client.ts             HTTP client used by thin clients (e.g. TUI)
tests/                            Vitest suites (unit/integration/e2e/live scopes)
container/src/                    Agent code (tools, HybridAI client, IPC)
templates/                        Workspace bootstrap files
data/                             Runtime data (gitignored): SQLite DB, sessions, agent workspaces
```
