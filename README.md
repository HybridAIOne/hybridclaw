# HybridClaw

[![CI](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/HybridAIOne/hybridclaw/gh-pages/badge/coverage.json)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hybridaione/hybridclaw)](https://www.npmjs.com/package/@hybridaione/hybridclaw)
[![Node](https://img.shields.io/badge/node-22.x-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/en/download)
[![License](https://img.shields.io/github/license/HybridAIOne/hybridclaw)](https://github.com/HybridAIOne/hybridclaw/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-github%20pages-blue)](https://hybridaione.github.io/hybridclaw/)
[![Powered by HybridAI](https://img.shields.io/badge/powered%20by-HybridAI-blueviolet)](https://hybridai.one)

<img width="540" height="511" alt="image" src="docs/hero.png" />

Personal AI assistant bot for Discord, powered by [HybridAI](https://hybridai.one).

## Install from npm

```bash
npm install -g @hybridaione/hybridclaw
hybridclaw onboarding
```

Prerequisites: Node.js 22. Docker is recommended when you want the default
container sandbox.

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

# For stdio MCP servers that rely on host tools like `docker` or `npx`
hybridclaw gateway start --foreground --sandbox=host

# If DISCORD_TOKEN is set, gateway auto-connects to Discord.
# If linked WhatsApp auth exists, gateway auto-connects to WhatsApp.

# Start terminal adapter (optional, in a second terminal)
hybridclaw tui

# Web chat UI (built into gateway)
# open http://127.0.0.1:9090/chat

# Agent and session dashboard
# open http://127.0.0.1:9090/agents

# Embedded admin console
# open http://127.0.0.1:9090/admin
# Includes Dashboard, Sessions, Channels, Config, Models, Scheduler, MCP, Audit, Skills, and Tools
# If WEB_API_TOKEN is unset, localhost access opens without a login prompt
```

## Authentication

HybridClaw uses a unified provider setup surface:

```bash
hybridclaw auth login hybridai --browser
hybridclaw auth login codex --import
hybridclaw auth login openrouter anthropic/claude-sonnet-4 --api-key sk-or-...
hybridclaw auth login local ollama llama3.2
hybridclaw auth status hybridai
hybridclaw auth status codex
hybridclaw auth status openrouter
hybridclaw auth status local
hybridclaw auth logout hybridai
hybridclaw auth logout codex
hybridclaw auth logout openrouter
hybridclaw auth logout local
hybridclaw auth whatsapp reset
```

Legacy aliases are also supported:

```bash
hybridclaw hybridai login --browser
hybridclaw codex status
hybridclaw local configure ollama llama3.2
```

- `hybridclaw auth login` without a provider runs the normal onboarding flow.
- `hybridclaw auth login hybridai` auto-selects browser login on local GUI machines and a manual/headless API-key flow on SSH, CI, and container shells. `--import` copies the current `HYBRIDAI_API_KEY` from your shell into `~/.hybridclaw/credentials.json`.
- `hybridclaw auth login codex` auto-selects browser PKCE on local GUI machines and device code on headless or remote shells.
- `hybridclaw auth login openrouter` accepts `--api-key`, falls back to `OPENROUTER_API_KEY`, or prompts you to paste the key, then enables the provider and can set the global default model.
- `hybridclaw auth login local` configures Ollama, LM Studio, or vLLM in `~/.hybridclaw/config.json`.
- `hybridclaw auth logout local` disables configured local backends and clears any saved vLLM API key.
- `hybridclaw auth whatsapp reset` clears linked WhatsApp Web auth without starting a new pairing session.
- HybridAI and OpenRouter secrets are stored in `~/.hybridclaw/credentials.json`. Codex OAuth credentials are stored separately in `~/.hybridclaw/codex-auth.json`.
- Only one running HybridClaw process should own `~/.hybridclaw/credentials/whatsapp` at a time. If WhatsApp Web shows duplicate Chrome/Ubuntu linked devices or reconnect/auth drift starts, stop the extra process, run `hybridclaw auth whatsapp reset`, then pair again with `hybridclaw channels whatsapp setup`.
- Use `hybridclaw help`, `hybridclaw help auth`, `hybridclaw help openrouter`, or `hybridclaw help local` for CLI-specific reference output.

## Model Selection

Codex models use the `openai-codex/` prefix. OpenRouter models use the `openrouter/` prefix. The default shipped Codex model is `openai-codex/gpt-5-codex`.

Examples:

```text
/model set openai-codex/gpt-5-codex
/model list codex
/model default openai-codex/gpt-5-codex
/model list openrouter
/model set openrouter/anthropic/claude-sonnet-4
/model clear
/agent model openrouter/anthropic/claude-sonnet-4
/model info
/model default openrouter/anthropic/claude-sonnet-4
```

- `hybridai.defaultModel` in `~/.hybridclaw/config.json` can point at a HybridAI model, an `openai-codex/...` model, an `openrouter/...` model, or a local backend model such as `ollama/...`.
- `codex.models` in runtime config controls the allowed Codex model list shown in selectors and status output.
- `openrouter.models` in runtime config controls the allowed OpenRouter model list shown in selectors and status output.
- When the selected model starts with `openai-codex/`, HybridClaw resolves OAuth credentials through the Codex provider instead of `HYBRIDAI_API_KEY`.
- When the selected model starts with `openrouter/`, HybridClaw resolves credentials through `OPENROUTER_API_KEY`.
- `/model set <name>` is a session-only override.
- `/model clear` removes the session override and falls back to the current agent model or the global default.
- `/agent model <name>` sets the persistent model for the current session agent.
- `/model info` shows the current model configuration by scope (global default, agent model, and any session override).
- Use `HYBRIDCLAW_CODEX_BASE_URL` to override the default Codex backend base URL (`https://chatgpt.com/backend-api/codex`).

Runtime model:

- `hybridclaw gateway` is the core process and should run first.
- If `DISCORD_TOKEN` is set, Discord runs inside gateway automatically.
- If linked WhatsApp auth exists under `~/.hybridclaw/credentials/whatsapp`, WhatsApp runs inside gateway automatically.
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
- `container.*` controls execution isolation, including `sandboxMode`, `memory`, `memorySwap`, `cpus`, `network`, `binds`, and additional mounts.
- Use `container.binds` for explicit host-to-container mounts in `host:container[:ro|rw]` format. Mounted paths appear inside the sandbox under `/workspace/extra/<container>`.
- `mcpServers.*` declares Model Context Protocol servers that HybridClaw connects to per session and exposes as namespaced tools (`server__tool`).
- `mcpServers.*.env` and `mcpServers.*.headers` are currently written to `~/.hybridclaw/config.json` as plain text. Use low-privilege tokens only, set `chmod 700 ~/.hybridclaw && chmod 600 ~/.hybridclaw/config.json`, and prefer `host` sandbox mode for stdio MCP servers that depend on host-installed tools.
- `media.audio` controls shared inbound audio transcription. By default it auto-detects local CLIs first (`sherpa-onnx-offline`, `whisper-cli`, `whisper`), then `gemini`, then provider keys (`openai`, `groq`, `deepgram`, `google`).
- `whisper-cli` auto-detect also needs a whisper.cpp model file. If the binary exists but HybridClaw still skips local transcription, set `WHISPER_CPP_MODEL` to a local `ggml-*.bin` model path.
- If no transcript backend is available, the container tries native model audio input before tool-use fallback for supported local providers. Today that fallback is enabled for `vllm` sessions and uses the original current-turn audio attachment.
- Keep runtime secrets in `~/.hybridclaw/credentials.json` (`HYBRIDAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `DISCORD_TOKEN`). Codex OAuth sessions are stored separately in `~/.hybridclaw/codex-auth.json`.
- Trust-model acceptance is stored in `~/.hybridclaw/config.json` under `security.*` and is required before runtime starts.
- See [TRUST_MODEL.md](./TRUST_MODEL.md) for onboarding acceptance policy and [SECURITY.md](./SECURITY.md) for technical security guidelines.
- For contributor workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md). For deeper runtime, skills, release, voice/TTS, and maintainer reference docs, see [docs/development/README.md](./docs/development/README.md).

## Local Provider Quickstart (LM Studio Example)

If LM Studio is running locally and serving `qwen/qwen3.5-9b` on
`http://127.0.0.1:1234`, use this setup:

1. Configure HybridClaw for LM Studio:

```bash
hybridclaw auth login local lmstudio qwen/qwen3.5-9b --base-url http://127.0.0.1:1234
```

This enables local providers, enables the LM Studio backend, normalizes the
URL to `http://127.0.0.1:1234/v1`, and sets the default model to
`lmstudio/qwen/qwen3.5-9b`.

2. Restart the gateway in host sandbox mode:

```bash
hybridclaw gateway restart --foreground --sandbox=host
```

If the gateway is not running yet, use:

```bash
hybridclaw gateway start --foreground --sandbox=host
```

3. Check that HybridClaw can see LM Studio:

```bash
hybridclaw gateway status
```

Look for `localBackends.lmstudio.reachable: true`.

You can also inspect the saved local backend config directly:

```bash
hybridclaw auth status local
```

4. Start the TUI:

```bash
hybridclaw tui
```

In the TUI, run:

```text
/model list
/model list openrouter
/model set lmstudio/qwen/qwen3.5-9b
/model clear
/model info
```

Then send a normal prompt.

If you want to configure the backend without changing your global default model,
use:

```bash
hybridclaw auth login local lmstudio qwen/qwen3.5-9b --base-url http://127.0.0.1:1234 --no-default
```

Other backends use the same flow:

```bash
hybridclaw auth login local ollama llama3.2
hybridclaw auth login local vllm mistralai/Mistral-7B-Instruct-v0.3 --base-url http://127.0.0.1:8000 --api-key secret
```

Restart the gateway in `--sandbox=host`, then confirm reachability with
`hybridclaw gateway status`.

Notes:

- LM Studio often shows its server as `http://127.0.0.1:1234`, but HybridClaw
  should be configured with `http://127.0.0.1:1234/v1`.
- Qwen models on LM Studio use the OpenAI-compatible `/v1` API with Qwen tool
  and thinking compatibility enabled automatically.
- For agent mode, load at least `16k` context in LM Studio. `32k` is the safer
  default for longer sessions and tool use.
- The TUI `/model` picker and Discord `/model` slash command choices are built
  from the live gateway model list, so restart the gateway after enabling a new
  local backend or loading a different local model.

## TUI MCP Quickstart

For stdio MCP servers that use host binaries such as `docker`, `node`, or
`npx`, start the gateway in host mode:

```bash
hybridclaw gateway start --foreground --sandbox=host
hybridclaw tui
```

In the TUI, use the MCP slash commands directly:

```text
/mcp list
/mcp add filesystem {"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/Users/you/project"],"enabled":true}
/mcp toggle filesystem
/mcp reconnect filesystem
/mcp remove filesystem
```

Once a server is enabled, its tools appear in prompts as namespaced tool names
such as `filesystem__read_file` or `github__list_issues`.

## Bundled Skills

- `pdf` is bundled and supports text extraction, page rendering, fillable form inspection/filling, and non-fillable overlay workflows.
- `xlsx` is bundled for spreadsheet creation, formula-safe editing, CSV/TSV cleanup, and LibreOffice-backed recalculation.
- `docx` is bundled for Word document creation plus OOXML unpack/edit/pack workflows, comments, and tracked-change cleanup.
- `pptx` is bundled for presentation creation with `pptxgenjs`, template-preserving OOXML edits, and thumbnail-based visual QA.
- `office-workflows` is bundled for cross-format tasks such as CSV to XLSX cleanup and XLSX to PPTX or DOCX deliverables coordinated with delegation.
- Use `hybridclaw skill list` to inspect available installers and `hybridclaw skill install pdf [install-id]` when a bundled skill advertises optional setup helpers.

## Optional Office Dependencies

When you run HybridClaw in the default container sandbox, the bundled office image already includes the main office tooling. These installs matter primarily for `--sandbox=host` workflows or when you want the same capabilities on your local machine.

What they unlock:

- LibreOffice (`soffice`) enables Office-to-PDF export, PPTX visual QA, and XLSX formula recalculation.
- Poppler (`pdftoppm`) enables slide/page thumbnail rendering for PPTX visual QA.
- Pandoc improves document conversion workflows around DOCX and Markdown.

macOS:

```bash
brew install --cask libreoffice
brew install poppler pandoc
```

Ubuntu / Debian:

```bash
sudo apt-get update
sudo apt-get install -y libreoffice poppler-utils pandoc
```

Fedora:

```bash
sudo dnf install -y libreoffice poppler-utils pandoc
```

Verify availability:

```bash
sh -lc 'command -v soffice >/dev/null 2>&1 || command -v libreoffice >/dev/null 2>&1 && echo soffice_ok'
sh -lc 'command -v pdftoppm >/dev/null 2>&1 && echo pdftoppm_ok'
sh -lc 'command -v pandoc >/dev/null 2>&1 && echo pandoc_ok'
```

Without these tools, the office skills still create and edit `.docx`, `.xlsx`, and `.pptx` files, but some higher-quality QA and conversion paths are skipped.

## Commands

CLI runtime commands:

- `hybridclaw --version` / `-v` — Print installed HybridClaw version
- `hybridclaw gateway start [--foreground] [--sandbox=container|host]` — Start gateway (backend by default; foreground with flag)
- `hybridclaw gateway restart [--foreground] [--sandbox=container|host]` — Restart managed gateway backend process
- `hybridclaw gateway stop` — Stop managed gateway backend process
- `hybridclaw gateway status` — Show lifecycle/API status
- `hybridclaw gateway <command...>` — Send a command to a running gateway (for example `sessions`, `bot info`)
- `hybridclaw gateway agent [list|switch <id>|create <id> [--model <model>]|model [name]]` — Inspect or change the current session-to-agent binding and persistent agent model
- `hybridclaw gateway compact` — Archive older session history into semantic memory while preserving a recent active context tail
- `hybridclaw gateway reset [yes|no]` — Clear session history, reset per-session model/chatbot/RAG settings, and remove the current agent workspace (confirmation required)
- `hybridclaw tui` — Start terminal client connected to gateway
- `hybridclaw onboarding` — Run trust-model acceptance plus interactive provider onboarding
- `hybridclaw auth login [provider] ...` — Namespaced provider setup/login entrypoint
- `hybridclaw auth status <provider>` — Show provider status for `hybridai`, `codex`, `openrouter`, or `local`
- `hybridclaw auth logout <provider>` — Clear provider credentials or disable local backends
- `hybridclaw auth whatsapp reset` — Clear linked WhatsApp auth so the account can be re-paired cleanly
- `hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]` — Prepare restricted command-only Discord config and print bot/token next steps
- `hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...` — Prepare private-by-default WhatsApp config, enable the default `👀` ack reaction, optionally wipe stale auth, open a temporary pairing session, and print the QR code
- `hybridclaw local status` — Show current local backend config and default model
- `hybridclaw local configure <backend> <model-id> [--base-url <url>] [--api-key <key>] [--no-default]` — Enable and configure a local backend
- `hybridclaw hybridai ...`, `hybridclaw codex ...`, and `hybridclaw local ...` — Legacy aliases for the older provider-specific command surface
- `hybridclaw help` / `hybridclaw help auth` / `hybridclaw help openrouter` — Print CLI reference for the unified provider commands
- `hybridclaw skill list` — Show skills and any declared installer options
- `hybridclaw skill install <skill> [install-id]` — Run a declared skill dependency installer
- `hybridclaw update [status|--check] [--yes]` — Check for updates and upgrade global npm installs (source checkouts get git-based update instructions)
- `hybridclaw audit ...` — Verify and inspect structured audit trail (`recent`, `search`, `approvals`, `verify`, `instructions`)
- `hybridclaw audit instructions [--sync]` — Compare runtime instruction copies under `~/.hybridclaw/instructions/` against installed sources and restore shipped defaults when needed

In Discord, use `!claw help` or the slash commands. Key ones:

- `!claw <message>` — Talk to the agent
- `/agent` or `!claw agent` — Show the current session agent and workspace
- `/agent list` or `!claw agent list` — List configured agents
- `/agent switch <id>` or `!claw agent switch <id>` — Rebind this session to another agent workspace
- `/agent create <id> [--model <model>]` or `!claw agent create <id> [--model <model>]` — Create a new agent with its own workspace
- `/agent model [name]` or `!claw agent model [name]` — Show or set the persistent model for the current agent
- `!claw bot set <id>` — Set chatbot for this channel
- `!claw model set <name>` — Set the session model override for this channel
- `!claw model clear` — Clear the session model override and fall back to the current agent model or global default
- `!claw model info` — Show the effective model, session override, agent model, and global default
- `!claw rag on/off` — Toggle RAG
- `!claw compact` — Archive older history into session memory and keep a recent working tail
- `/reset` or `!claw reset` — Clear history, reset per-session model/bot settings, and remove the current agent workspace (confirmation required)
- `!claw clear` — Clear conversation history
- `!claw audit recent [n]` — Show recent structured audit events
- `!claw audit verify [sessionId]` — Verify audit hash chain integrity
- `!claw audit search <query>` — Search structured audit history
- `!claw audit approvals [n] [--denied]` — Show policy approval decisions
- `!claw usage [summary|daily|monthly|model [daily|monthly] [agentId]]` — Show token/cost aggregates
- `!claw export session [sessionId]` — Export session snapshot as JSONL
- `!claw mcp list` — List configured MCP servers
- `!claw mcp add <name> <json>` — Add or update an MCP server config
- `!claw schedule add "<cron>" <prompt>` — Add cron scheduled task
- `!claw schedule add at "<ISO time>" <prompt>` — Add one-shot task
- `!claw schedule add every <ms> <prompt>` — Add interval task

In the TUI, use `/agent`, `/agent list`, `/agent switch <id>`, `/agent create
<id> [--model <model>]`, and `/agent model [name]` for agent control. Use
`/model set <name>` for a session-only override, `/model clear` to fall back to
the agent/default model chain, and `/model info` to inspect the active scope.
`/status` shows both the current session and agent; `/compact` handles session
compaction; `/reset` runs the confirmed workspace reset flow; and `/mcp ...`
manages runtime MCP servers.
