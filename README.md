# HybridClaw

[![CI](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/HybridAIOne/hybridclaw/gh-pages/badge/coverage.json)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hybridaione/hybridclaw)](https://www.npmjs.com/package/@hybridaione/hybridclaw)
[![Node](https://img.shields.io/badge/node-22.x-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/en/download)
[![License](https://img.shields.io/github/license/HybridAIOne/hybridclaw)](https://github.com/HybridAIOne/hybridclaw/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-github%20pages-blue)](https://hybridaione.github.io/hybridclaw/)
[![Powered by HybridAI](https://img.shields.io/badge/powered%20by-HybridAI-blueviolet)](https://hybridai.one)
[![Discord](https://img.shields.io/badge/Discord-join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/jsVW4vJw27)

<img width="540" height="511" alt="image" src="docs/hero.png" />

Personal AI assistant for Discord, Microsoft Teams, iMessage, WhatsApp, email,
web, and terminal, powered by [HybridAI](https://hybridai.one).

HybridClaw keeps one assistant brain across team chat, inbox, browser, and
document workflows with shared memory, approvals, scheduling, and bundled
skills for office docs, GitHub, Notion, Stripe, WordPress, Google Workspace,
and Apple apps.
Portable `.claw` packages can snapshot an agent workspace plus bundled skills
and plugins for transfer or backup, and persistent browser profiles let the
agent reuse authenticated web sessions for later browser automation.
Local plugins can extend the gateway with typed manifests, plugin tools,
memory layers, prompt hooks, and lifecycle hooks, including the installable
QMD-backed memory layer shipped in `plugins/qmd-memory`.
Web chat and TUI can attach current-turn files, and inline context references
like `@file:src/app.ts`, `@diff`, or `@url:https://example.com/spec` can
ground a turn without pasting raw content.

Operators can also health-check the runtime with `hybridclaw doctor`, tune
skill availability globally or per channel, and review adaptive skill health
and amendment history from the CLI, TUI, or admin surfaces.
For turn-level debugging, gateway start/restart can also persist best-effort
redacted prompts, responses, and tool payloads with `--log-requests`.

## Install from npm

```bash
npm install -g @hybridaione/hybridclaw
hybridclaw onboarding
```

Prerequisites: Node.js 22. Docker is recommended when you want the default
container sandbox. The published install bootstraps the packaged container
runtime dependencies during `npm install -g`.
The current release tag is
[v0.9.7](https://github.com/HybridAIOne/hybridclaw/releases/tag/v0.9.7).
Release notes live in [CHANGELOG.md](./CHANGELOG.md), and the browsable
operator and maintainer manual lives under
[docs/development/README.md](./docs/development/README.md).

## HybridAI Advantage

- Security-focused foundation
- Enterprise-ready stack
- EU-stack compatibility
- GDPR-aligned posture
- RAG-powered retrieval
- Document-grounded responses

## Architecture

- **Gateway service** (Node.js) — shared message/command handlers, SQLite persistence (KV + semantic + knowledge graph + canonical sessions + usage events), scheduler, heartbeat, web/API, and channel integrations for Discord, Microsoft Teams, iMessage, WhatsApp, and email
- **TUI client** — thin client over HTTP (`/api/chat`, `/api/command`) with
  a structured startup banner that surfaces model, sandbox, gateway, and
  chatbot context before the first prompt
- **Container** (Docker, ephemeral) — HybridAI API client, sandboxed tool executor, and preinstalled browser automation runtime with cursor-aware snapshots for JS-heavy custom UI
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

# If msteams.enabled=true and MSTEAMS_APP_PASSWORD is configured, gateway auto-connects to Microsoft Teams.
# If DISCORD_TOKEN is set, gateway auto-connects to Discord.
# If imessage.enabled=true, gateway auto-connects to iMessage using the configured backend.
# If email.enabled=true and EMAIL_PASSWORD is configured, gateway auto-connects to Email.
# If linked WhatsApp auth exists, gateway auto-connects to WhatsApp.

# Start terminal adapter (optional, in a second terminal)
hybridclaw tui

# Web chat UI (built into gateway)
# open http://127.0.0.1:9090/chat

# Agent and session dashboard
# open http://127.0.0.1:9090/agents

# Embedded admin console
# open http://127.0.0.1:9090/admin
# Browser terminal page
# open http://127.0.0.1:9090/admin/terminal
# Includes Dashboard, Terminal, Gateway, Sessions, Jobs, Bindings, Models, Scheduler, MCP, Audit, Skills, Plugins, Tools, and Config
# If WEB_API_TOKEN is unset, localhost access opens without a login prompt
# If WEB_API_TOKEN is set, /chat, /agents, and /admin all prompt for the same token
```

## Authentication

HybridClaw uses a unified provider setup surface:

```bash
hybridclaw auth login hybridai --browser
hybridclaw auth login hybridai --base-url http://localhost:5000
hybridclaw auth login codex --import
hybridclaw auth login openrouter anthropic/claude-sonnet-4 --api-key sk-or-...
hybridclaw auth login mistral mistral-large-latest --api-key mistral_...
hybridclaw auth login huggingface meta-llama/Llama-3.1-8B-Instruct --api-key hf_...
hybridclaw auth login local ollama llama3.2
hybridclaw auth login msteams --app-id 00000000-0000-0000-0000-000000000000 --tenant-id 11111111-1111-1111-1111-111111111111 --app-password secret
hybridclaw auth status hybridai
hybridclaw auth status codex
hybridclaw auth status openrouter
hybridclaw auth status mistral
hybridclaw auth status huggingface
hybridclaw auth status local
hybridclaw auth status msteams
hybridclaw auth logout hybridai
hybridclaw auth logout codex
hybridclaw auth logout openrouter
hybridclaw auth logout mistral
hybridclaw auth logout huggingface
hybridclaw auth logout local
hybridclaw auth logout msteams
hybridclaw auth whatsapp reset
```

Legacy aliases are also supported:

```bash
hybridclaw hybridai login --browser
hybridclaw codex status
hybridclaw local configure ollama llama3.2
```

- `hybridclaw auth login` without a provider runs the normal onboarding flow.
- `hybridclaw auth login hybridai` auto-selects browser login on local GUI machines and a manual/headless API-key flow on SSH, CI, and container shells. `--import` copies the current `HYBRIDAI_API_KEY` from your shell into `~/.hybridclaw/credentials.json`, and `--base-url` updates `hybridai.baseUrl` before login.
- `hybridclaw auth login codex` auto-selects browser PKCE on local GUI machines and device code on headless or remote shells.
- `hybridclaw auth login openrouter` accepts `--api-key`, falls back to `OPENROUTER_API_KEY`, or prompts you to paste the key, then enables the provider and can set the global default model.
- `hybridclaw auth login mistral` accepts `--api-key`, falls back to `MISTRAL_API_KEY`, or prompts you to paste the key, then enables the provider and can set the global default model.
- `hybridclaw auth login huggingface` accepts `--api-key`, falls back to `HF_TOKEN`, or prompts you to paste the token, then enables the provider and can set the global default model.
- `hybridclaw auth login local` configures Ollama, LM Studio, or vLLM in `~/.hybridclaw/config.json`.
- `hybridclaw auth login msteams` enables Microsoft Teams, stores `MSTEAMS_APP_PASSWORD` in `~/.hybridclaw/credentials.json`, and can prompt for the app id, app password, and optional tenant id.
- `hybridclaw auth status hybridai` reports the local auth source, masked API key, active config file, base URL, and default model without printing the credentials file path.
- `hybridclaw auth logout local` disables configured local backends and clears any saved vLLM API key.
- `hybridclaw auth logout msteams` clears the stored Teams app password and disables the Teams integration in config.
- `hybridclaw auth whatsapp reset` clears linked WhatsApp Web auth without starting a new pairing session.
- HybridAI, OpenRouter, Mistral, Hugging Face, Discord, email, Teams, and BlueBubbles iMessage secrets are stored in `~/.hybridclaw/credentials.json`. Codex OAuth credentials are stored separately in `~/.hybridclaw/codex-auth.json`.
- Only one running HybridClaw process should own `~/.hybridclaw/credentials/whatsapp` at a time. If WhatsApp Web shows duplicate Chrome/Ubuntu linked devices or reconnect/auth drift starts, stop the extra process, run `hybridclaw auth whatsapp reset`, then pair again with `hybridclaw channels whatsapp setup`.
- Use `hybridclaw help`, `hybridclaw help auth`, `hybridclaw help openrouter`, `hybridclaw help mistral`, `hybridclaw help huggingface`, or `hybridclaw help local` for CLI-specific reference output.

## Setting Up MS Teams

See [docs/msteams.md](./docs/msteams.md) for the full setup flow, including:

- Azure app registration and bot credentials
- Azure Bot webhook and Teams channel configuration
- `hybridclaw auth login msteams`
- local tunnel setup
- DM and channel smoke tests

## Setting Up iMessage

See [docs/imessage.md](./docs/imessage.md) for the full setup flow, including:

- local macOS mode with `imsg` and Messages `chat.db`
- remote/cloud mode with BlueBubbles webhooks + REST sends
- `imessage.*` config examples for both backends
- `IMESSAGE_PASSWORD` secret handling for BlueBubbles
- DM/group policy notes and smoke-test steps

## Model Selection

Codex models use the `openai-codex/` prefix. OpenRouter models use the `openrouter/` prefix. Mistral models use the `mistral/` prefix. Hugging Face router models use the `huggingface/` prefix. The default shipped Codex model is `openai-codex/gpt-5-codex`.

Examples:

```text
/model set openai-codex/gpt-5-codex
/model list codex
/model default openai-codex/gpt-5-codex
/model list openrouter
/model set openrouter/anthropic/claude-sonnet-4
/model list mistral
/model set mistral/mistral-large-latest
/model list huggingface
/model set huggingface/meta-llama/Llama-3.1-8B-Instruct
/model clear
/agent model openrouter/anthropic/claude-sonnet-4
/model info
/model default openrouter/anthropic/claude-sonnet-4
/concierge info
/concierge on
/concierge model gemini-3-flash
/concierge profile no_hurry ollama/qwen3:latest
```

- `hybridai.defaultModel` in `~/.hybridclaw/config.json` can point at a HybridAI model, an `openai-codex/...` model, an `openrouter/...` model, a `mistral/...` model, a `huggingface/...` model, or a local backend model such as `ollama/...`.
- `codex.models` in runtime config controls the allowed Codex model list shown in selectors and status output.
- `openrouter.models` in runtime config controls the allowed OpenRouter model list shown in selectors and status output.
- `mistral.models` in runtime config controls the allowed Mistral model list shown in selectors and status output.
- `huggingface.models` in runtime config controls the allowed Hugging Face model list shown in selectors and status output.
- HybridAI model lists are refreshed from the configured HybridAI base URL (`/models`, then `/v1/models` as a compatibility fallback), and discovered `context_length` values feed status and model-info output when the API exposes them.
- When the selected model starts with `openai-codex/`, HybridClaw resolves OAuth credentials through the Codex provider instead of `HYBRIDAI_API_KEY`.
- When the selected model starts with `openrouter/`, HybridClaw resolves credentials through `OPENROUTER_API_KEY`.
- When the selected model starts with `mistral/`, HybridClaw resolves credentials through `MISTRAL_API_KEY`.
- When the selected model starts with `huggingface/`, HybridClaw resolves credentials through `HF_TOKEN`.
- `/model set <name>` is a session-only override.
- `/model clear` removes the session override and falls back to the current agent model or the global default.
- `/agent model <name>` sets the persistent model for the current session agent.
- `/model info` shows the current model configuration by scope (global default, agent model, and any session override).
- `/concierge on|off` toggles the global concierge router that can ask users about urgency before long-running requests.
- `/concierge model [name]` shows or sets the small decision model used for concierge routing.
- `/concierge profile <asap|balanced|no_hurry> [model]` shows or sets the execution model mapped to each concierge urgency profile.
- Use `HYBRIDAI_BASE_URL` to override `hybridai.baseUrl` for the current
  process without rewriting `~/.hybridclaw/config.json`, which is useful for
  local or preview HybridAI deployments.
- Use `HYBRIDCLAW_CODEX_BASE_URL` to override the default Codex backend base URL (`https://chatgpt.com/backend-api/codex`).

Runtime model:

- `hybridclaw gateway` is the core process and should run first.
- If `msteams.enabled` is true and `MSTEAMS_APP_PASSWORD` is configured, Microsoft Teams runs inside gateway automatically.
- If `DISCORD_TOKEN` is set, Discord runs inside gateway automatically.
- If `imessage.enabled` is true, iMessage runs inside gateway automatically using either the local macOS backend or the configured BlueBubbles server.
- If `email.enabled` is true and `EMAIL_PASSWORD` is configured, Email runs inside gateway automatically.
- If linked WhatsApp auth exists under `~/.hybridclaw/credentials/whatsapp`, WhatsApp runs inside gateway automatically.
- `hybridclaw tui` is a thin client that connects to the gateway.
- `hybridclaw gateway` and `hybridclaw tui` validate the container image at startup.
- `container.sandboxMode` defaults to `container`, but if HybridClaw is already running inside a container and the setting is not explicitly pinned, the gateway auto-switches to `host` to avoid Docker-in-Docker.
- Use `hybridclaw gateway start --sandbox=host` or `hybridclaw gateway restart --sandbox=host` to force host execution for a given launch.
- On first run from an installed package, HybridClaw pulls a published container image automatically. In a source checkout, it builds the local container image instead.
- If Docker is unavailable, install Docker or switch to `container.sandboxMode=host`.

## Configuration

HybridClaw creates `~/.hybridclaw/config.json` on first run and hot-reloads most runtime settings.

- Start from `config.example.json` (reference).
- Runtime state lives under `~/.hybridclaw/` (`config.json`, `credentials.json`, `data/hybridclaw.db`, audit/session files). Set `HYBRIDCLAW_DATA_DIR` to an absolute path to relocate the full runtime home, including browser profiles and agent workspaces.
- HybridClaw does not keep runtime state in the current working directory. If `./.env` exists, supported secrets are migrated once into `~/.hybridclaw/credentials.json`.
- `container.*` controls execution isolation, including `sandboxMode`, `memory`, `memorySwap`, `cpus`, `network`, `binds`, and additional mounts.
- `hybridclaw config` prints the active runtime config path and current config, `config check` validates only the config file itself, `config reload` performs an immediate in-process hot reload, and `config set <key> <value>` updates one existing dotted key path and re-validates the result.
- Use `container.binds` for explicit host-to-container mounts in `host:container[:ro|rw]` format. Mounted paths appear inside the sandbox under `/workspace/extra/<container>`.
- In `host` sandbox mode, the agent can access the user home directory, the gateway working directory, `/tmp`, and any host paths explicitly added through `container.binds` or `container.additionalMounts`.
- `mcpServers.*` declares Model Context Protocol servers that HybridClaw connects to per session and exposes as namespaced tools (`server__tool`).
- `sessionReset.*` controls automatic daily and idle session expiry. The default policy resets both daily and after 24 hours idle at `04:00` in the gateway host's local timezone; set `sessionReset.defaultPolicy.mode` to `none` to disable automatic resets.
- `sessionRouting.*` controls DM continuity scope. The default `per-channel-peer` mode keeps direct messages isolated by transport and peer identity; `per-linked-identity` plus `sessionRouting.identityLinks` can collapse verified aliases onto one shared main session.
- `agents.defaultAgentId` selects the default agent for new requests and fresh web sessions when the user does not pin an agent explicitly.
- `hybridai.maxTokens` controls the default HybridAI completion output budget. The shipped default is `4096`, and it can be adjusted live with `hybridclaw config set hybridai.maxTokens <n>`.
- `skills.disabled` and `skills.channelDisabled.{discord,msteams,whatsapp,email}` control global and per-channel skill availability. Use `hybridclaw skill enable|disable <name> [--channel <kind>]` or the TUI `/skill config` checklist to manage them.
- `plugins.list[]` controls plugin overrides such as `enabled`, custom `path`, and top-level `config` values. Use `hybridclaw plugin config <plugin-id> [key] [value|--unset]` for focused edits without rewriting the full config file.
- `observability.*` controls HybridAI observability ingest, including the target base URL, bot and agent ids, flush interval, and batch size for structured audit event forwarding.
- `adaptiveSkills.*` controls observation, inspection, amendment staging, and rollback for the self-improving skill loop. See [docs/development/extensibility/adaptive-skills.md](./docs/development/extensibility/adaptive-skills.md) for the operator workflow.
- `imessage.*` controls the dual-backend iMessage transport. Use `backend: "local"` on macOS with `imsg` + `chat.db`, or `backend: "bluebubbles"` for a remote Mac relay via BlueBubbles. Prefer storing the BlueBubbles password in `~/.hybridclaw/credentials.json` as `IMESSAGE_PASSWORD` instead of plaintext config.
- `email.pollIntervalMs` defaults to `30000` (30 seconds) and is clamped to a minimum of `1000`.
- `ops.webApiToken` (or `WEB_API_TOKEN`) gates the built-in `/chat`, `/agents`, and `/admin` surfaces plus the admin API. When unset, localhost browser access stays open without a login prompt.
- `mcpServers.*.env` and `mcpServers.*.headers` are currently written to `~/.hybridclaw/config.json` as plain text. Use low-privilege tokens only, set `chmod 700 ~/.hybridclaw && chmod 600 ~/.hybridclaw/config.json`, and prefer `host` sandbox mode for stdio MCP servers that depend on host-installed tools.
- `media.audio` controls shared inbound audio transcription. By default it auto-detects local CLIs first (`sherpa-onnx-offline`, `whisper-cli`, `whisper`), then `gemini`, then provider keys (`openai`, `groq`, `deepgram`, `google`).
- `whisper-cli` auto-detect also needs a whisper.cpp model file. If the binary exists but HybridClaw still skips local transcription, set `WHISPER_CPP_MODEL` to a local `ggml-*.bin` model path.
- If no transcript backend is available, the container tries native model audio input before tool-use fallback for supported local providers. Today that fallback is enabled for `vllm` sessions and uses the original current-turn audio attachment.
- Keep runtime secrets in `~/.hybridclaw/credentials.json` (`HYBRIDAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `DISCORD_TOKEN`, `EMAIL_PASSWORD`, `IMESSAGE_PASSWORD`, `MSTEAMS_APP_PASSWORD`). Codex OAuth sessions are stored separately in `~/.hybridclaw/codex-auth.json`.
- Trust-model acceptance is stored in `~/.hybridclaw/config.json` under `security.*` and is required before runtime starts. In headless environments, set `HYBRIDCLAW_ACCEPT_TRUST=true` to persist acceptance automatically before credential checks run.
- See [TRUST_MODEL.md](./TRUST_MODEL.md) for onboarding acceptance policy and [SECURITY.md](./SECURITY.md) for technical security guidelines.
- For contributor workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md). For deeper runtime, skills, release, voice/TTS, and maintainer reference docs, see [docs/development/README.md](./docs/development/README.md).

## Diagnostics

Use `hybridclaw doctor` when setup, auth, Docker, or runtime state looks
wrong. It runs independent checks for runtime, gateway, config, credentials,
database, providers, local backends, Docker, channels, skills, security, and
disk state in parallel.

- `hybridclaw doctor --fix` applies safe remediations where the check exposes
  one, then reruns the fixable checks.
- `hybridclaw doctor --json` prints a machine-readable report for CI or
  automation while still returning exit code `1` if errors remain.
- `hybridclaw doctor docker`, `hybridclaw doctor providers`, and the other
  category names narrow the report to one subsystem.
- `hybridclaw gateway start --log-requests` or
  `hybridclaw gateway restart --log-requests` persists best-effort redacted
  prompts, responses, and tool payloads to SQLite `request_log` for
  turn-level debugging. Treat that table as sensitive operator data.

## Authenticated Browser Sessions

Use the browser profile commands when the agent needs to work inside a site
that requires a real login:

```bash
hybridclaw browser login --url https://accounts.google.com
hybridclaw browser status
hybridclaw browser reset
```

- `browser login` opens a headed Chromium profile stored under the HybridClaw
  runtime data directory and waits for you to close the browser when setup is
  finished.
- Browser sessions persist across turns and are made available to browser
  automation automatically, so follow-up browser tasks can reuse cookies and
  local storage without exposing credentials in chat.
- Treat the browser profile directory as sensitive operator data.

## Context References And Attachments

HybridClaw can ground a prompt with current-turn uploads or inline context
references instead of making you paste large blobs manually.

```text
Explain this regression using @diff and @file:src/gateway/gateway.ts:120-220
Compare @folder:docs/development with @url:https://example.com/spec
```

- Web chat accepts uploads and pasted clipboard items for images, audio, PDFs,
  Office docs, and text files before send.
- TUI queues a copied local file or clipboard image with `/paste` or `Ctrl-V`
  before sending.
- Inline references supported in prompts are `@file:path[:start-end]`,
  `@folder:path`, `@diff`, `@staged`, `@git:<count>`, and
  `@url:https://...`.
- If a reference is blocked or too large, HybridClaw keeps the prompt text and
  adds a warning instead of silently broadening access.

## Agent Packages

HybridClaw can package an agent into a portable `.claw` archive for backup,
distribution, or bootstrap flows:

```bash
hybridclaw agent list
hybridclaw agent export main -o /tmp/main.claw
hybridclaw agent inspect /tmp/main.claw
hybridclaw agent install /tmp/main.claw --id demo-agent --yes
hybridclaw agent install official:charly-neumann-executive-briefing-chief-of-staff --yes
hybridclaw agent activate demo-agent
```

- `agent export` exports the workspace plus optional bundled workspace skills
  and home plugins.
- `agent inspect` validates the manifest and prints archive metadata without
  extracting it.
- `agent install` restores the agent, fills missing bootstrap files, and
  re-registers bundled content with the runtime from a local `.claw` file or a
  packaged GitHub source such as `official:<agent-dir>` or
  `github:owner/repo[/<ref>]/<agent-dir>`.
- `.claw` manifests can include agent presentation metadata such as a
  `displayName` and workspace-relative profile image asset for web chat.
- `agent activate <agent-id>` sets the default agent for new requests that do
  not specify one explicitly.
- Legacy aliases still work: `agent pack` maps to `export`, and `agent unpack`
  maps to `install`.
- See [docs/development/extensibility/agent-packages.md](./docs/development/extensibility/agent-packages.md)
  for the archive layout, manifest fields, and security rules.

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

HybridClaw currently ships with 30 bundled skills. Notable workflow and app
integrations include:

- `pdf` is bundled and supports text extraction, page rendering, fillable form inspection/filling, and non-fillable overlay workflows.
- `xlsx` is bundled for spreadsheet creation, formula-safe editing, CSV/TSV cleanup, and LibreOffice-backed recalculation.
- `docx` is bundled for Word document creation plus OOXML unpack/edit/pack workflows, comments, and tracked-change cleanup.
- `pptx` is bundled for presentation creation with `pptxgenjs`, template-preserving OOXML edits, and thumbnail-based visual QA.
- `office-workflows` is bundled for cross-format tasks such as CSV to XLSX cleanup and XLSX to PPTX or DOCX deliverables coordinated with delegation.
- `notion` is bundled for Notion workspace pages, block content, and data-source workflows over the Notion API.
- `trello` is bundled for board, list, and card management in lightweight Kanban workflows.
- `project-manager` is bundled for sprint plans, milestone breakdowns, risk registers, and stakeholder updates.
- `feature-planning` is bundled for repo-aware implementation plans, task sequencing, acceptance criteria, and validation strategy before coding.
- `code-review` is bundled for local diff reviews, PR reviews, risk-focused findings, and test-gap analysis.
- `code-simplification` is bundled for behavior-preserving refactors that reduce nesting, duplication, and unnecessary abstraction.
- `github-pr-workflow` is bundled for branch creation, commits, PR authoring, CI follow-up, and merge-readiness workflows with GitHub.
- `write-blog-post` is bundled for audience-aware blog post outlines and drafts built from briefs, notes, transcripts, or source material.
- `discord` is bundled for Discord channel operations through the `message` tool, including reads, sends, reactions, pins, and threads.
- `google-workspace` is bundled for Gmail, Calendar, Drive, Docs, and Sheets setup guidance plus browser/API workflow coordination.
- `1password` is bundled for secure `op`-based secret lookup and command injection workflows.
- `stripe` is bundled for Stripe API, CLI, Dashboard, checkout, billing, and webhook-debugging workflows with a test-mode-first default.
- `sokosumi` is bundled for API-key-authenticated Sokosumi agent hires, coworker tasks, job monitoring, and result retrieval without relying on the Ink TUI.
- `wordpress` is bundled for WP-CLI, wp-admin, and draft-first content publishing workflows on WordPress sites.
- `apple-calendar` is bundled for Apple Calendar or iCal workflows, especially `.ics` drafting/import and macOS calendar coordination.
- `apple-passwords` is bundled for Passwords.app and Keychain-backed credential lookup on macOS.
- `apple-music` is bundled for macOS Music app playback control, now-playing checks, and Apple Music URL workflows.
- Use `hybridclaw skill list` to inspect available installers and `hybridclaw skill install pdf [install-id]` when a bundled skill advertises optional setup helpers.
- Use `hybridclaw skill import official/himalaya` to install the packaged Himalaya community skill into `~/.hybridclaw/skills` for host-side IMAP/SMTP email workflows.
- Use `hybridclaw skill import <source>` to install community skills into `~/.hybridclaw/skills` from `skills-sh/anthropics/skills/brand-guidelines`, `clawhub/brand-voice`, `lobehub/github-issue-helper`, `claude-marketplace/brand-guidelines@anthropic-agent-skills`, `well-known:https://mintlify.com/docs`, or explicit GitHub repo/path refs such as `anthropics/skills/skills/brand-guidelines`.
- Use `hybridclaw skill import --force <source>` to override a `caution` scanner verdict for a reviewed community skill. `dangerous` verdicts stay blocked.

Skills can be disabled globally or per channel kind (`discord`, `msteams`,
`whatsapp`, `email`) with `hybridclaw skill enable|disable <name> [--channel <kind>]`
or via the TUI `/skill config` screen. For observation-driven health and
amendment workflows, use `hybridclaw skill inspect|runs|learn|history` or the
admin `Skills` page.

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
- `hybridclaw gateway start [--foreground] [--debug] [--log-requests] [--sandbox=container|host]` — Start gateway (backend by default; foreground with flag)
- `hybridclaw gateway restart [--foreground] [--debug] [--log-requests] [--sandbox=container|host]` — Restart managed gateway backend process
- `hybridclaw gateway stop` — Stop managed gateway backend process
- `hybridclaw gateway status` — Show lifecycle/API status
- `hybridclaw gateway <command...>` — Send a command to a running gateway (for example `sessions`, `bot info`)
- `hybridclaw gateway concierge [info|on|off|model [name]|profile <asap|balanced|no_hurry> [model]]` — Inspect or configure concierge routing defaults
- `hybridclaw gateway agent [list|switch <id>|create <id> [--model <model>]|model [name]]` — Inspect or change the current session-to-agent binding and persistent agent model
- `hybridclaw gateway compact` — Archive older session history into semantic memory while preserving a recent active context tail
- `hybridclaw gateway reset [yes|no]` — Clear session history, reset per-session model/chatbot/RAG settings, and remove the current agent workspace (confirmation required)
- `hybridclaw agent list` — Show registered agents in a script-friendly tab-separated format
- `hybridclaw agent export [agent-id] [-o <path>]`, `inspect <file.claw>`, `install <file.claw> [--id <id>]`, `uninstall <agent-id> [--yes]` — Manage portable `.claw` agent archives (legacy `pack` / `unpack` aliases still work)
- `hybridclaw tui` — Start terminal client connected to gateway
- `hybridclaw tui --resume <sessionId>` / `hybridclaw --resume <sessionId>` — Resume an earlier TUI session by canonical session id
- `hybridclaw onboarding` — Run trust-model acceptance plus interactive provider onboarding
- `hybridclaw auth login [provider] ...` — Namespaced provider setup/login entrypoint
- `hybridclaw auth status <provider>` — Show provider status for `hybridai`, `codex`, `openrouter`, `mistral`, `huggingface`, `local`, or `msteams`
- `hybridclaw auth logout <provider>` — Clear provider credentials or disable local backends/Teams
- `hybridclaw config`, `check`, `reload`, `set <key> <value>` — Inspect, validate, hot-reload, or edit the local runtime config file
- `hybridclaw auth login msteams [--app-id <id>] [--app-password <secret>] [--tenant-id <id>]` — Enable Microsoft Teams, persist the app secret, and print webhook next steps
- `hybridclaw auth whatsapp reset` — Clear linked WhatsApp auth so the account can be re-paired cleanly
- `hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]` — Prepare restricted command-only Discord config and print bot/token next steps
- `hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--imap-port <port>] [--imap-secure|--no-imap-secure] [--smtp-host <host>] [--smtp-port <port>] [--smtp-secure|--no-smtp-secure] [--folder <name>]... [--allow-from <email|*@domain|*>]... [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>]` — Configure IMAP/SMTP email delivery, optionally prompt for missing credentials, default to a 30-second IMAP poll interval, and save `EMAIL_PASSWORD`
- `hybridclaw channels imessage setup [--backend <local|remote>] [--allow-from <phone|email|chat:id>]... [--server-url <url>] [--password <password>] [--cli-path <path>] [--db-path <path>] [--webhook-path <path>] [--allow-private-network]` — Configure either the local macOS `imsg` backend or the BlueBubbles relay backend, store `IMESSAGE_PASSWORD` when needed, and keep inbound iMessage private-by-default unless handles are allowlisted
- `hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...` — Prepare private-by-default WhatsApp config, enable the default `👀` ack reaction, optionally wipe stale auth, open a temporary pairing session, and print the QR code
- `hybridclaw browser login [--url <url>]`, `status`, `reset` — Manage the persistent browser profile used for authenticated web automation
- `hybridclaw local status` — Show current local backend config and default model
- `hybridclaw local configure <backend> <model-id> [--base-url <url>] [--api-key <key>] [--no-default]` — Enable and configure a local backend
- `hybridclaw hybridai ...`, `hybridclaw codex ...`, and `hybridclaw local ...` — Legacy aliases for the older provider-specific command surface
- `hybridclaw help` / `hybridclaw help auth` / `hybridclaw help openrouter` / `hybridclaw help mistral` — Print CLI reference for the unified provider commands
- `hybridclaw doctor [--fix|--json|<component>]` — Diagnose runtime, gateway, config, credentials, database, providers, local backends, Docker, channels, skills, security, and disk state
- `hybridclaw skill list` — Show skills and any declared installer options
- `hybridclaw skill enable <skill-name> [--channel <kind>]`, `disable`, `toggle` — Manage global and per-channel skill availability
- `hybridclaw skill inspect <skill-name>` / `hybridclaw skill inspect --all`, `runs`, `learn`, `history` — Review adaptive skill health, observations, and amendment history
- `hybridclaw skill import [--force] <source>` — Import a packaged community skill with `official/<skill-name>` or a community skill from `skills-sh`, `clawhub`, `lobehub`, `claude-marketplace`, `well-known`, or an explicit GitHub repo/path into `~/.hybridclaw/skills`; `--force` only overrides `caution`, never `dangerous`
- `hybridclaw skill install <skill> [install-id]` — Run a declared skill dependency installer
- `hybridclaw plugin list` — Show discovered plugins, enabled state, registered tools/hooks, and load errors
- `hybridclaw plugin config <plugin-id> [key] [value|--unset]` — Inspect or change one top-level `plugins.list[].config` override
- `hybridclaw plugin enable <plugin-id>` / `disable <plugin-id>` — Toggle one top-level `plugins.list[].enabled` override for local plugin recovery
- `hybridclaw plugin install <path|npm-spec>`, `reinstall`, `uninstall` — Manage plugins installed under `~/.hybridclaw/plugins`
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
- `!claw export trace [sessionId|all]` — Export ATIF-compatible trace JSONL for one session or every session
- `!claw mcp list` — List configured MCP servers
- `!claw mcp add <name> <json>` — Add or update an MCP server config
- `!claw schedule add "<cron>" <prompt>` — Add cron scheduled task
- `!claw schedule add at "<ISO time>" <prompt>` — Add one-shot task
- `!claw schedule add every <ms> <prompt>` — Add interval task

In the TUI, typing `/` opens the slash-command menu with inline filtering and
help aliases, while the startup banner summarizes the active model, sandbox,
gateway, provider, and chatbot context before the first prompt. Pressing
Up/Down on an empty prompt recalls earlier prompts. Use `/agent`, `/agent list`, `/agent switch <id>`, `/agent create
<id> [--model <model>]`, and `/agent model [name]` for agent control. Use
`/model set <name>` for a session-only override, `/model clear` to fall back to
the agent/default model chain, and `/model info` to inspect the active scope.
`/status` shows both the current session and agent; `/compact` handles session
compaction; `/reset` runs the confirmed workspace reset flow; `/skill config`
opens the interactive skill availability checklist; `/config`, `/config check`,
`/config reload`, and `/config set <key> <value>` manage the local runtime
config; `/auth status hybridai` shows local HybridAI auth/config state;
`/plugin list`, `/plugin config ...`, `/plugin enable`, `/plugin disable`,
`/plugin install`, `/plugin reinstall`, and `/plugin reload` manage runtime
plugins; and `/mcp ...` manages runtime MCP servers. Press `Ctrl-C` or `Ctrl-D`
twice within five seconds to exit. When a TUI session exits, HybridClaw prints
the input/output token split, tool/file totals, and a ready-to-run
`hybridclaw tui --resume <sessionId>` command for that session.
