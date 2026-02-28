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
- **Container** (Docker, ephemeral) — HybridAI API client, sandboxed tool executor
- Communication via file-based IPC (input.json / output.json)

## Quick start

```bash
# Install dependencies (this also installs container deps via postinstall)
npm install

# Run onboarding (also auto-runs on first `gateway`/`tui` start if API key is missing)
# On first run, it creates `.env` from `.env.example` automatically if needed.
hybridclaw onboarding

# Onboarding flow:
# 1) explicitly accept SECURITY.md trust model (required)
# 2) choose whether to create a new account
# 3) open /register in browser (optional) and confirm in terminal
# 4) open /login?next=/admin_api_keys in browser and get an API key
# 5) paste API key (or URL containing it) back into the CLI
# 6) choose the default bot and save credentials to `.env`

# Start the gateway core runtime first
hybridclaw gateway

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
- `hybridclaw gateway` and `hybridclaw tui` validate the container image at startup and build it automatically if missing.

Maintainers can publish the package to npm using:

```bash
npm publish --access public
```

Best-in-class harness upgrades now in runtime:

- explicit trust-model acceptance during onboarding (recorded in `config.json`)
- typed `config.json` runtime settings with defaults, validation, and hot reload
- formal prompt hook orchestration (`bootstrap`, `memory`, `safety`)

## Configuration

HybridClaw now uses typed runtime config in `config.json` (auto-created on first run).

- Start from `config.example.json` (reference)
- Runtime watches `config.json` and hot-reloads most settings (model defaults, heartbeat, prompt hooks, limits, etc.)
- Some settings still require restart to fully apply (for example HTTP bind host/port)

Secrets remain in `.env`:

- `HYBRIDAI_API_KEY` (required)
- `DISCORD_TOKEN` (optional)
- `WEB_API_TOKEN` and `GATEWAY_API_TOKEN` (optional API auth hardening)

Trust-model acceptance is stored in `config.json` under `security.*` and is required before runtime starts.

See [SECURITY.md](./SECURITY.md) for policy and acceptance details.

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
- `web_fetch` — fetch a URL and extract readable content (HTML → markdown/text)

HybridClaw also supports automatic session compaction with pre-compaction memory flush:

- when a session gets long, old turns are summarized into `session_summary`
- before compaction, the agent gets a `memory`-only flush turn to persist durable notes

System prompt assembly is handled by a formal hook pipeline:

- `bootstrap` hook (workspace bootstrap + skills metadata)
- `memory` hook (session summary)
- `safety` hook (runtime guardrails / trust-model constraints)

Hook toggles live in `config.json` under `promptHooks`.

## Commands

CLI runtime commands:

- `hybridclaw gateway` — Start core runtime (web/API/scheduler/heartbeat and optional Discord)
- `hybridclaw tui` — Start terminal client connected to gateway
- `hybridclaw onboarding` — Run HybridAI account/API key onboarding

In Discord, use `!claw help` to see all commands. Key ones:

- `!claw <message>` — Talk to the agent
- `!claw bot set <id>` — Set chatbot for this channel
- `!claw model set <name>` — Set model for this channel
- `!claw rag on/off` — Toggle RAG
- `!claw clear` — Clear conversation history
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
