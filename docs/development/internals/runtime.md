---
title: Runtime Internals
description: Sandboxing, configuration, diagnostics, audit paths, and operational behavior inside the HybridClaw runtime.
sidebar_position: 3
---

# Runtime Internals

## Container Runtime Image

HybridClaw runtime commands (`gateway`, `tui`, `onboarding`) use a local Docker
image matching `container.image` (default: `hybridclaw-agent`) when sandbox mode
is `container`. In `host` sandbox mode they run the packaged agent runtime
directly instead.

When the image is missing, startup logic in `src/container-setup.ts` does:

1. For installed packages, pull a remote image. For the default image it tries
   GHCR `v<app-version>`, then `latest`, then Docker Hub.
2. For source checkouts, build a local image with `npm run build:container`.

If Docker is not installed or not on `PATH`, container-mode startup fails fast.
Install Docker or switch to `container.sandboxMode=host` to run without it.

Maintainer overrides:

- `HYBRIDCLAW_CONTAINER_PULL_IMAGE=<registry/image:tag>` forces a specific pull
  target
- `HYBRIDCLAW_CONTAINER_REBUILD=if-stale|always|never` adjusts rebuild policy
- `HYBRIDCLAW_CONTAINER_IMAGE=<name[:tag]> npm run build:container` builds and
  tags a custom image

Build context hygiene is enforced by `container/.dockerignore` to avoid shipping
local secrets or artifacts into published images.
Published images also include the built `/chat` and `/agents` browser assets so
the embedded web surfaces work from release images instead of source checkouts
only.

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
- Runtime config, credentials, and data live under `~/.hybridclaw/*` by
  default.
- `HYBRIDCLAW_DATA_DIR` can relocate that full runtime home to an absolute
  path, including `config.json`, `credentials.json`, the SQLite database,
  browser profiles, and agent workspaces.
- Startup no longer probes or migrates `./config.json` or `./data` from the
  current working directory, and only reads `./.env` to import supported
  secrets into the encrypted `~/.hybridclaw/credentials.json` store.
- Runtime secrets are encrypted at rest with a separately sourced master key:
  `HYBRIDCLAW_MASTER_KEY`, `/run/secrets/hybridclaw_master_key`, or the local
  owner-only `~/.hybridclaw/credentials.master.key` fallback.
- The encrypted secret store accepts both built-in runtime secret keys and
  named secrets created through `/secret set <NAME> <VALUE>`.
- Selected runtime config fields can use SecretRefs (`store` or `env`) instead
  of plaintext values, and `tools.httpRequest.authRules[]` binds URL prefixes
  to gateway-injected secret headers for the `http_request` tool.
- Some settings still require restart, such as bind host and port.
- Default HybridAI chatbot is configured via `hybridai.defaultChatbotId`.
- Agents are configured under `agents.defaults` and `agents.list`. Sessions bind
  to an agent, and that agent owns the workspace under
  `~/.hybridclaw/data/agents/<workspace>/workspace/`.
- `hybridai.maxTokens` sets the default completion budget per model call.
- Trust-model acceptance is persisted under `security.*` and enforced before
  runtime start. In non-interactive shells, `HYBRIDCLAW_ACCEPT_TRUST=true` can
  persist acceptance automatically before credential validation runs.
- `ops.webApiToken` (and the `WEB_API_TOKEN` env var) gate the built-in
  `/chat`, `/agents`, `/admin`, and admin API surfaces when set.
- `HEALTH_HOST` can override the health server bind address without rewriting
  runtime config, which is useful in containerized or proxied deployments.
- `mcpServers.*.env` and `mcpServers.*.headers` are persisted in
  `~/.hybridclaw/config.json` exactly as configured today. Treat them as
  plaintext secrets and lock the runtime directory down with
  `chmod 700 ~/.hybridclaw && chmod 600 ~/.hybridclaw/config.json`.
- `http_request` tool-call logs are redacted before persistence so placeholder
  or secret-backed headers do not store plaintext credentials in the audit
  trail.
- `mcpServers.*` are forwarded into each session runtime and hot-diffed there.
  Stdio servers resolve inside the active sandbox, so host-installed helpers
  like `docker`, `node`, or `npx` require `container.sandboxMode=host` (or a
  matching binary inside the container image).

Common advanced areas:

- Discord behavior and policy controls: `discord.*` and `discord.guilds.*`
- Approval policy controls (workspace-local): `./.hybridclaw/policy.yaml`
- Scheduler jobs: `scheduler.jobs[]` with cron, every, or at delivery targets
- Memory compaction and consolidation: `sessionCompaction.*`, `memory.*`
- Session continuity and DM isolation: `sessionRouting.*`
- Skill availability: `skills.disabled`, `skills.channelDisabled.*`
- Adaptive skill observation/amendment loop: `adaptiveSkills.*`
- Proactive runtime: `proactive.*`
- MCP server registry: `mcpServers.*`
- Plugin overrides: `plugins.list[]`
- Observability export: `observability.*`
- Skills roots: `skills.extraDirs`

## Runtime Diagnostics

`hybridclaw doctor` is the operator-facing health check for local runtime
issues. It runs these categories in parallel:

- `runtime`
- `gateway`
- `config`
- `credentials`
- `database`
- `providers`
- `local-backends`
- `docker`
- `channels`
- `skills`
- `security`
- `disk`

Useful flags:

- `--fix` applies safe remediations for checks that expose one, then reruns the
  fixable checks
- `--json` emits a machine-readable report for CI or shell automation while
  still returning exit code `1` if errors remain
- `hybridclaw doctor <category>` narrows the report to one subsystem

The command is intended for first-install triage, auth/provider drift, Docker
or gateway liveness checks, file-permission issues, and other local operator
problems that are faster to diagnose from one aggregated report.

## Session Routing Internals

HybridClaw separates concrete transport identity from continuity scope:

- `session_key` identifies the specific transport conversation
- `main_session_key` identifies the continuity scope used by current-session
  lookup and canonical memory windows

The default routing mode is `sessionRouting.dmScope = "per-channel-peer"`,
which isolates DM continuity by channel kind and peer identity. Operators can
opt into `per-linked-identity` and supply `sessionRouting.identityLinks` to
collapse verified aliases onto one main session scope.

Canonical keys use a marker-based format:

```text
agent:<agentId>:channel:<channelKind>:chat:<chatType>:peer:<peerId>
```

Optional typed segments such as `:thread:`, `:topic:`, and `:subagent:` can be
appended without changing the parser contract. Malformed canonical keys are
rejected at the boundary rather than being treated as legacy ids.

For the routing rules and operator guidance, see
[Session Routing](./session-routing.md).

## Web Surfaces And API Auth

HybridClaw's built-in browser surfaces share one auth model:

- `/chat` is the end-user chat UI
- `/agents` shows logical agents plus live/persisted session cards
- `/admin` serves the embedded operator console, including the `Plugins` page
  for discovery and load-status inspection

When `WEB_API_TOKEN` / `ops.webApiToken` is configured, these surfaces prompt
for the token and reuse it for subsequent API calls. When unset, localhost
access stays open without a browser login prompt.
The `/auth/callback` flow can also persist `WEB_API_TOKEN` into browser
`localStorage` before redirecting so the token never has to remain in the URL
after login.

Session behavior matches the routing rules above:

- `/api/chat` can mint a fresh canonical web session id when the caller omits
  `sessionId`
- recognized slash-text commands submitted to `/api/chat` for web sessions are
  routed through the same gateway command path used by TUI/other text channels
- `/api/command` and `/api/history` require an explicit `sessionId`
- malformed canonical session ids are rejected instead of being treated as
  opaque legacy ids
- `/auth/callback?next=/path` only accepts relative redirect targets that start
  with `/` but not `//`; invalid or unsafe values fall back to `/admin`

## Persistent Browser Profiles

HybridClaw can reuse a real logged-in browser session for later automation:

```bash
hybridclaw browser login [--url <url>]
hybridclaw browser status
hybridclaw browser reset
```

Runtime details:

- The shared profile directory lives under
  `<runtime-home>/data/browser-profiles/`.
- In `container` sandbox mode, that directory is mounted into agent containers
  and exposed to browser automation. In `host` mode, the same profile is reused
  directly by the local runtime.
- `browser login` opens a headed Chromium instance with that shared profile so
  the operator can complete MFA, SSO, captchas, or any other login steps
  outside the chat loop.
- Treat the profile directory as sensitive operator data because it may contain
  cookies, local storage, and other authenticated browser state.

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
- Worker pools are keyed by backend/provider signature, so changing the local
  target or auth for a session respawns the pooled worker without reusing stale
  runtime state.
- Local backends no longer imply separate workspaces. A session keeps the same
  workspace as long as it stays bound to the same agent, even when the model or
  provider changes.
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

## Session Reset Workflow

Gateway `reset [yes|no]`, TUI `/reset`, and Discord `/reset` share the same
runtime flow:

- `reset` stages a pending confirmation containing the current agent workspace
  path.
- `reset yes` stops any in-flight execution, clears session history, resets
  per-session model/chatbot overrides plus RAG to defaults, and removes the
  current agent workspace.
- If a workspace has been recreated before the next turn, HybridClaw drops
  stale transcript history for that session so conversation state stays aligned
  with the new workspace and tool surface.

## Agent And Session Model

HybridClaw now distinguishes between agents and sessions explicitly:

- an **agent** owns a workspace, optional default model, optional default
  chatbot, and durable memory
- a **session** is a channel/client conversation handle that binds to an agent
- changing the model/provider for a session does not change the workspace
  unless the session is switched to a different agent

Current resolution order for a turn:

1. request/session chooses the session
2. session chooses the bound `agent_id`
3. agent chooses the workspace and agent defaults
4. effective model is resolved from request/session override first, then agent
   default, then global defaults

Operational surfaces:

- `agent`, `agent list`, `agent switch <id>`, `agent create <id> [--model <model>]`
  are available through gateway commands, TUI, web chat slash-text, and
  Discord slash/text commands
- `status` now includes the current session agent
- `/agents` shows both logical agents and per-session runtime cards

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
