# HybridClaw

<img width="540" height="511" alt="image" src="docs/hero.png" />

Personal AI assistant bot for Discord, powered by [HybridAI](https://hybridai.one).

## Install from npm

```bash
npm install -g @hybridaione/hybridclaw
hybridclaw onboarding
```

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
- proactive runtime layer with active-hours gating, push delegation (`single`/`parallel`/`chain`), depth-aware tool policy, and retry controls
- structured audit trail: append-only hash-chained wire logs (`data/audit/<session>/wire.jsonl`) with tamper-evident immutability, normalized SQLite audit tables, and verification/search CLI commands
- instruction-integrity approval flow: core instruction docs (`AGENTS.md`, `SECURITY.md`, `TRUST_MODEL.md`) are hash-verified against a local approved baseline before TUI start

## Configuration

HybridClaw uses typed runtime config in `config.json` (auto-created on first run).

- Start from `config.example.json` (reference)
- Runtime watches `config.json` and hot-reloads most settings (model defaults, heartbeat, prompt hooks, limits, etc.)
- `proactive.*` controls autonomous behavior (`activeHours`, `delegation`, `autoRetry`)
- Some settings require restart to fully apply (for example HTTP bind host/port)
- Default bot is configured via `hybridai.defaultChatbotId` in `config.json` (legacy `HYBRIDAI_CHATBOT_ID` values are auto-migrated on startup)

Secrets remain in `.env`:

- `HYBRIDAI_API_KEY` (required)
- `DISCORD_TOKEN` (optional)
- `WEB_API_TOKEN` and `GATEWAY_API_TOKEN` (optional API auth hardening)

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

- `./skills/<skill-name>/SKILL.md` (project-level)
- `<agent workspace>/skills/<skill-name>/SKILL.md` (agent-specific)
- `$CODEX_HOME/skills/<skill-name>/SKILL.md`, `~/.codex/skills/<skill-name>/SKILL.md`, or `~/.claude/skills/<skill-name>/SKILL.md` (managed/shared)

Load precedence is:

- managed/shared < project < agent workspace

### Required format

Each skill must be a folder with a `SKILL.md` file and frontmatter:

```markdown
---
name: repo-orientation
description: Quickly map an unfamiliar repository and identify where a requested feature should be implemented.
user-invocable: true
disable-model-invocation: false
---

# Repo Orientation
...instructions...
```

Supported frontmatter keys:

- `name` (required)
- `description` (required)
- `user-invocable` (optional, default `true`)
- `disable-model-invocation` (optional, default `false`)

### Using skills

Skills are listed to the model as metadata (`name`, `description`, `location`), and the model reads `SKILL.md` on demand with the `read` tool.

Explicit invocation is supported via:

- `/skill <name> [input]`
- `/skill:<name> [input]`
- `/<name> [input]` (when `user-invocable: true`)

Example skill in this repo:

- `skills/repo-orientation/SKILL.md`

## Agent tools

The agent has access to these sandboxed tools inside the container:

- `read` / `write` / `edit` / `delete` — file operations
- `glob` / `grep` — file search
- `bash` — shell command execution
- `memory` — durable memory files (`MEMORY.md`, `USER.md`, `memory/YYYY-MM-DD.md`)
- `session_search` — search/summarize historical sessions from transcript archives
- `delegate` — push-based background subagent tasks (`single`, `parallel`, `chain`) with auto-announced completion (no polling)
- `web_fetch` — fetch a URL and extract readable content (HTML → markdown/text)
- `browser_*` (optional) — interactive browser automation (`navigate`, `snapshot`, `click`, `type`, `press`, `scroll`, `back`, `screenshot`, `pdf`, `close`)

`delegate` mode examples:

- single: `{ "prompt": "Audit auth middleware and list risks", "label": "auth-audit" }`
- parallel: `{ "mode": "parallel", "label": "module-audit", "tasks": [{ "prompt": "Scan api/" }, { "prompt": "Scan ui/" }] }`
- chain: `{ "mode": "chain", "label": "implement-flow", "chain": [{ "prompt": "Scout the payment module" }, { "prompt": "Plan changes from: {previous}" }, { "prompt": "Implement based on: {previous}" }] }`

Browser tooling notes:

- The shipped container image preinstalls `agent-browser` and Chromium (Playwright).
- You can override the binary via `AGENT_BROWSER_BIN` if needed.
- Navigation to private/loopback hosts is blocked by default (set `BROWSER_ALLOW_PRIVATE_NETWORK=true` to override).
- Screenshot/PDF outputs are constrained to `/workspace/.browser-artifacts`.

HybridClaw also supports automatic session compaction with pre-compaction memory flush:

- when a session gets long, old turns are summarized into `session_summary`
- before compaction, the agent gets a `memory`-only flush turn to persist durable notes

System prompt assembly is handled by a formal hook pipeline:

- `bootstrap` hook (workspace bootstrap + skills metadata)
- `memory` hook (session summary)
- `safety` hook (runtime guardrails / trust-model constraints)
- `proactivity` hook (memory capture, session recall, delegation behavior)

Hook toggles live in `config.json` under `promptHooks`.

## Commands

CLI runtime commands:

- `hybridclaw gateway start [--foreground]` — Start gateway (backend by default; foreground with flag)
- `hybridclaw gateway stop` — Stop managed gateway backend process
- `hybridclaw gateway status` — Show lifecycle/API status
- `hybridclaw gateway <command...>` — Send a command to a running gateway (for example `sessions`, `bot info`)
- `hybridclaw tui` — Start terminal client connected to gateway
- `hybridclaw onboarding` — Run HybridAI account/API key onboarding
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
- `!claw schedule add "<cron>" <prompt>` — Add scheduled task

## Project structure

```
src/gateway.ts          Core runtime entrypoint (DB, scheduler, heartbeat, HTTP API)
src/tui.ts              Terminal adapter (thin client to gateway)
src/discord.ts          Discord integration and message transport
src/gateway-service.ts  Core shared agent/session logic used by gateway API
src/gateway-client.ts   HTTP client used by thin clients (e.g. TUI)
container/src/          Agent code (tools, HybridAI client, IPC)
templates/              Workspace bootstrap files
data/                   Runtime data (gitignored): SQLite DB, sessions, agent workspaces
```
