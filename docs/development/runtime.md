# Runtime Internals

## Container Runtime Image

HybridClaw runtime commands (`gateway`, `tui`, `onboarding`) use a local Docker
image matching `container.image` (default: `hybridclaw-agent`) when sandbox mode
is `container`. In `host` sandbox mode they run the packaged agent runtime
directly instead.

When the image is missing, startup logic in `src/container-setup.ts` does:

1. Pull a remote image. For the default image it tries GHCR `v<app-version>`,
   then `latest`, then Docker Hub.
2. If pull fails, run a local build with `npm run build:container`.

Maintainer overrides:

- `HYBRIDCLAW_CONTAINER_PULL_IMAGE=<registry/image:tag>` forces a specific pull
  target
- `HYBRIDCLAW_CONTAINER_REBUILD=if-stale|always|never` adjusts rebuild policy
- `HYBRIDCLAW_CONTAINER_IMAGE=<name[:tag]> npm run build:container` builds and
  tags a custom image

Build context hygiene is enforced by `container/.dockerignore` to avoid shipping
local secrets or artifacts into published images.

## Sandbox Modes

HybridClaw can execute agent turns in two modes:

- `container` is the default. It runs the agent inside Docker with a read-only
  rootfs, dropped capabilities, `no-new-privileges`, PID limits, and tunable
  `container.memory`, `container.memorySwap`, `container.cpus`, and
  `container.network`.
- `host` runs the bundled `container/dist/` runtime directly. Use it when
  HybridClaw itself is already running inside a container and Docker-in-Docker
  is undesirable.
- Set `container.sandboxMode` in `~/.hybridclaw/config.json` to pin a mode, or
  override a single launch with
  `hybridclaw gateway start --sandbox=container|host` or
  `hybridclaw gateway restart --sandbox=container|host`.
- If HybridClaw detects it is already inside a container and the setting is not
  explicitly pinned, it auto-selects `host`.
- `hybridclaw gateway status` and `!claw status` surface the active sandbox mode
  and session count.

## Configuration Internals

HybridClaw runtime configuration is typed and validated in
`~/.hybridclaw/config.json`, which is auto-created on first run. Use
`config.example.json` as the reference.

Core details:

- Runtime hot-reloads most settings such as model defaults, heartbeat, prompt
  hooks, and limits.
- Runtime config, credentials, and data live under `~/.hybridclaw/*`.
- Startup no longer probes or migrates `./config.json` or `./data` from the
  current working directory, and only reads `./.env` to import supported
  secrets into `~/.hybridclaw/credentials.json`.
- Some settings still require restart, such as bind host and port.
- Default bot is configured via `hybridai.defaultChatbotId`.
- `hybridai.maxTokens` sets the default completion budget per model call.
- Trust-model acceptance is persisted under `security.*` and enforced before
  runtime start.
- `mcpServers.*.env` and `mcpServers.*.headers` are persisted in
  `~/.hybridclaw/config.json` exactly as configured today. Treat them as
  plaintext secrets and lock the runtime directory down with
  `chmod 700 ~/.hybridclaw && chmod 600 ~/.hybridclaw/config.json`.
- `mcpServers.*` are forwarded into each session runtime and hot-diffed there.
  Stdio servers resolve inside the active sandbox, so host-installed helpers
  like `docker`, `node`, or `npx` require `container.sandboxMode=host` (or a
  matching binary inside the container image).

Common advanced areas:

- Discord behavior and policy controls: `discord.*` and `discord.guilds.*`
- Approval policy controls (workspace-local): `./.hybridclaw/policy.yaml`
- Scheduler jobs: `scheduler.jobs[]` with cron, every, or at delivery targets
- Memory compaction and consolidation: `sessionCompaction.*`, `memory.*`
- Proactive runtime: `proactive.*`
- MCP server registry: `mcpServers.*`
- Observability export: `observability.*`
- Skills roots: `skills.extraDirs`

## MCP Runtime Notes

- Gateway commands `mcp list|add|remove|toggle|reconnect` update
  `~/.hybridclaw/config.json` and hot-reload future turns.
- The TUI forwards `/mcp ...` slash commands through the same gateway command
  path, including JSON-preserving handling for `/mcp add <name> <json>`.
- Container startup merges discovered MCP tools into the active tool list as
  namespaced functions (`server__tool`) alongside built-in tools.

## Audit Trail Internals

HybridClaw records forensic audit events by default:

- append-only session wire logs:
  `~/.hybridclaw/data/audit/<session>/wire.jsonl`
- tamper-evident hash chain from `_prevHash` to `_hash`
- normalized SQLite tables: `audit_events` and `approvals`

Useful maintainer commands:

- `hybridclaw audit recent 50`
- `hybridclaw audit search "tool.call" 50`
- `hybridclaw audit approvals 50 --denied`
- `hybridclaw audit verify <sessionId>`
- `hybridclaw audit instructions`
- `hybridclaw audit instructions --sync`

Instruction runtime copies:

- files: `~/.hybridclaw/instructions/SECURITY.md`,
  `~/.hybridclaw/instructions/TRUST_MODEL.md`
- source of truth: installed package files `SECURITY.md` and `TRUST_MODEL.md`
- `hybridclaw audit instructions` fails when runtime copies drift from installed
  sources
- `hybridclaw audit instructions --sync` restores runtime copies from installed
  sources
- `hybridclaw tui` performs this check before startup

## Observability Push Internals

HybridClaw can forward audit-derived events to HybridAI ingest:

- endpoint: `POST /api/v1/agent-observability/events:batch`
- token source: `POST /api/v1/agent-observability/ingest-token:ensure`
- source table: local `audit_events`, ordered by `id`
- persisted cursor: `observability_offsets`
- cached ingest tokens: `observability_ingest_tokens`

Runtime diagnostics:

- `GET /api/status` returns an `observability` status block.

## Local LLM Providers

HybridClaw can route agent turns to locally running LLM servers instead of
(or alongside) cloud providers. Three backends are supported:

- **Ollama** — default base URL `http://127.0.0.1:11434`
- **LM Studio** — default base URL `http://127.0.0.1:1234/v1`
- **vLLM** — default base URL `http://127.0.0.1:8000/v1`

Enable and configure a backend with:

```bash
hybridclaw local configure <backend> <model-id> [--base-url <url>] [--api-key <key>] [--no-default]
hybridclaw local status
```

Runtime details:

- Configuration is stored in `~/.hybridclaw/config.json` under `local.*`.
- Each backend gets its own `enabled` flag and `baseUrl`.
- Local models are prefixed with the backend name (e.g. `lmstudio/qwen/qwen3.5-9b`,
  `ollama/llama3`).
- The gateway discovers running backends at startup and exposes reachable
  models in `gateway status` and the TUI/Discord model picker.
- Each local provider gets its own agent workspace at
  `~/.hybridclaw/data/agents/<agentId>/workspace/`. Agent IDs are derived
  from the backend name (e.g. `lmstudio`, `ollama`).
- Local backends should be used with `--sandbox=host` since there is no
  need to route local traffic through Docker networking.

Container-side adaptations for local models:

- **Thinking extraction**: `<think>...</think>` blocks (used by Qwen and
  similar reasoning models) are stripped from visible output and logged
  separately.
- **Tool-call normalization**: XML-style `<tool_call>` tags and malformed
  JSON tool calls from smaller models are parsed, repaired, and normalized
  into the standard OpenAI tool-call format.

## Activity-Based Agent Timeout

The IPC read timeout (default `CONTAINER_TIMEOUT = 300_000 ms`) now supports
activity-based deadline extension:

- An `ActivityTracker` is created per agent turn and passed to `readOutput()`.
- The host runner (and container runner) call `activity.notify()` whenever
  agent stderr shows progress — text deltas, tool execution output, or
  stream debug lines.
- Each `notify()` call resets the timeout deadline, so a slow model making
  steady progress is never killed prematurely.
- If the agent goes silent for the full timeout window, the turn is aborted
  with a timeout error.

This is particularly important for local models that may take 30+ seconds
per iteration and easily exceed a fixed 5-minute wall clock over multiple
tool-call rounds.

## Agent Tool And Runtime Internals

Container-side sandboxed tool families:

- file tools: `read`, `write`, `edit`, `delete`
- search tools: `glob`, `grep`
- shell: `bash`
- memory and session tools: `memory`, `session_search`
- delegation: `delegate`
- web extraction: `web_fetch`
- optional browser automation: `browser_*`

Prompt and runtime internals:

- session compaction with pre-compaction memory flush
- prompt hook pipeline: `bootstrap`, `memory`, `safety`, `proactivity`
- hook config lives in `config.promptHooks`
