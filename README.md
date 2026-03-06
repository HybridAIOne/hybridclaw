# HybridClaw

<img width="540" height="511" alt="image" src="docs/hero.png" />

Personal AI assistant bot for Discord, powered by [HybridAI](https://hybridai.one).

## Install from npm

```bash
npm install -g @hybridaione/hybridclaw
hybridclaw onboarding
```

Latest release: [v0.3.1](https://github.com/HybridAIOne/hybridclaw/releases/tag/v0.3.1)

## HybridAI Advantage

- Security-focused foundation
- Enterprise-ready stack
- EU-stack compatibility
- GDPR-aligned posture
- RAG-powered retrieval
- Document-grounded responses

## Architecture

- **Gateway service** (Node.js) — shared message/command handlers, SQLite persistence (KV + semantic + knowledge graph + canonical sessions + usage events), scheduler, heartbeat, web/API, and optional Discord integration
- **TUI client** — thin client over HTTP (`/api/chat`, `/api/command`)
- **Container** (Docker, ephemeral) — HybridAI API client, sandboxed tool executor, and preinstalled browser automation runtime
- Communication via file-based IPC (input.json / output.json)

## Quick start

```bash
# Install dependencies
npm install

# Run onboarding (also auto-runs on first `gateway`/`tui` start if API key is missing)
hybridclaw onboarding

# Onboarding flow:
# 1) explicitly accept TRUST_MODEL.md (required)
# 2) choose whether to create a new account
# 3) open /register in browser (optional) and confirm in terminal
# 4) open /login?next=/admin_api_keys in browser and get an API key
# 5) paste API key (or URL containing it) back into the CLI
# 6) choose the default bot (saved to ~/.hybridclaw/config.json) and save secrets to ~/.hybridclaw/credentials.json

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

## Authentication

HybridClaw supports two auth paths:

- `HybridAI API key` via `hybridclaw onboarding`
- `OpenAI Codex OAuth` via `hybridclaw codex ...`

Codex commands:

```bash
hybridclaw codex login
hybridclaw codex login --device-code
hybridclaw codex login --browser
hybridclaw codex login --import
hybridclaw codex status
hybridclaw codex logout
```

- `hybridclaw codex login` auto-selects browser PKCE on local GUI machines and device code on headless or remote shells.
- Codex credentials are stored separately in `~/.hybridclaw/codex-auth.json`.
- HybridAI secrets remain in `~/.hybridclaw/credentials.json`.

## Model Selection

Codex models use the `openai-codex/` prefix. The default shipped Codex model is `openai-codex/gpt-5-codex`.

Examples:

```text
/model openai-codex/gpt-5-codex
/model default openai-codex/gpt-5-codex
```

- `hybridai.defaultModel` in `~/.hybridclaw/config.json` can point at either a HybridAI model or an `openai-codex/...` model.
- `codex.models` in runtime config controls the allowed Codex model list shown in selectors and status output.
- When the selected model starts with `openai-codex/`, HybridClaw resolves OAuth credentials through the Codex provider instead of `HYBRIDAI_API_KEY`.
- Use `HYBRIDCLAW_CODEX_BASE_URL` to override the default Codex backend base URL (`https://chatgpt.com/backend-api/codex`).

Runtime model:

- `hybridclaw gateway` is the core process and should run first.
- If `DISCORD_TOKEN` is set, Discord runs inside gateway automatically.
- `hybridclaw tui` is a thin client that connects to the gateway.
- `hybridclaw gateway` and `hybridclaw tui` validate the container image at startup.
- `container.sandboxMode` defaults to `container`, but if HybridClaw is already running inside a container and the setting is not explicitly pinned, the gateway auto-switches to `host` to avoid Docker-in-Docker.
- Use `hybridclaw gateway start --sandbox=host` or `hybridclaw gateway restart --sandbox=host` to force host execution for a given launch.
- On first run, HybridClaw automatically prepares that image (pulls a prebuilt image first, then falls back to local build if needed).
- If container setup fails, run `npm run build:container` in the project root and retry.

## Configuration

HybridClaw creates `~/.hybridclaw/config.json` on first run and hot-reloads most runtime settings.

- Start from `config.example.json` (reference).
- Runtime state lives under `~/.hybridclaw/` (`config.json`, `credentials.json`, `data/hybridclaw.db`, audit/session files).
- HybridClaw does not keep runtime state in the current working directory. If `./.env` exists, supported secrets are migrated once into `~/.hybridclaw/credentials.json`.
- `container.*` controls execution isolation, including `sandboxMode`, `memory`, `memorySwap`, `cpus`, `network`, and additional mounts.
- Keep HybridAI secrets in `~/.hybridclaw/credentials.json` (`HYBRIDAI_API_KEY` required for HybridAI models, `DISCORD_TOKEN` optional). Codex OAuth sessions are stored separately in `~/.hybridclaw/codex-auth.json`.
- Trust-model acceptance is stored in `~/.hybridclaw/config.json` under `security.*` and is required before runtime starts.
- See [TRUST_MODEL.md](./TRUST_MODEL.md) for onboarding acceptance policy and [SECURITY.md](./SECURITY.md) for technical security guidelines.
- For advanced configuration, audit/observability details, skills internals, agent tools, and developer docs, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Commands

CLI runtime commands:

- `hybridclaw --version` / `-v` — Print installed HybridClaw version
- `hybridclaw gateway start [--foreground] [--sandbox=container|host]` — Start gateway (backend by default; foreground with flag)
- `hybridclaw gateway restart [--foreground] [--sandbox=container|host]` — Restart managed gateway backend process
- `hybridclaw gateway stop` — Stop managed gateway backend process
- `hybridclaw gateway status` — Show lifecycle/API status
- `hybridclaw gateway <command...>` — Send a command to a running gateway (for example `sessions`, `bot info`)
- `hybridclaw tui` — Start terminal client connected to gateway
- `hybridclaw onboarding` — Run HybridAI account/API key onboarding
- `hybridclaw codex login [--device-code|--browser|--import]` — Authenticate OpenAI Codex via OAuth or one-time Codex CLI import
- `hybridclaw codex status` — Show stored Codex auth state, token mask, expiry, and source
- `hybridclaw codex logout` — Clear stored Codex credentials
- `hybridclaw update [status|--check] [--yes]` — Check for updates and upgrade global npm installs (source checkouts get git-based update instructions)
- `hybridclaw audit ...` — Verify and inspect structured audit trail (`recent`, `search`, `approvals`, `verify`, `instructions`)
- `hybridclaw audit instructions [--sync]` — Compare runtime instruction copies under `~/.hybridclaw/instructions/` against installed sources and restore shipped defaults when needed

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
