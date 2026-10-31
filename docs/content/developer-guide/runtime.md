---
title: Runtime Internals
description: Sandboxing, configuration, diagnostics, audit paths, and operational behavior inside the HybridClaw runtime.
sidebar_position: 3
---

# Runtime Internals

## Channel Target and Lifecycle Dispatch

`src/channels/channel-descriptors.ts` collects each channel's descriptor. Its
matcher classifies concrete destinations for session resets, proactive delivery,
scheduled delivery descriptions, and admin statistics. Kind names and aliases
used by skill configuration are resolved separately by `channel-registry.ts`;
a kind such as `signal` is not a delivery destination.

The same table drives gateway channel startup, config refresh, plugin availability
refresh, and shutdown. Channel gateway handlers and senders live beside their
transport. Descriptors load those handlers on demand so classifying a destination
does not load an optional SDK. Voice keeps its serialized refresh and drain
handling in the gateway.

Proactive delivery validates the target before queuing outside active hours.
Signal phone, UUID, and group targets are supported. Teams and Voice targets can
be classified for session resets and statistics, but their descriptors declare
`supportsProactive: false`, so proactive sends are rejected. Only `tui` uses the
local pull queue; unsupported destinations fail
instead of falling through to that queue. Sender failures remain failures and
never create a local delivery row.

Admin statistics returns `channelKind` for each destination, or `null` when the
gateway cannot classify it. The console groups these rows by the supplied kind
and displays unknown destinations individually.

## Container Runtime Image

HybridClaw runtime commands (`gateway`, `tui`, `onboarding`) use a local Docker
image matching `container.image` (default: `hybridclaw-agent`) when sandbox mode
is `container`. In `host` sandbox mode they run the packaged agent runtime
directly instead.

When the image is missing, startup logic in `src/infra/container-setup.ts` does:

1. For installed packages, pull a remote image. For the default image it tries
   Docker Hub `v<app-version>`, then `latest`.
2. For source checkouts, build a local image with `npm run build:container`.

Release-built images carry an OCI version label, and
`hybridclaw gateway status` uses that metadata plus the image id to report
which container image is currently active.

If Docker is not installed or not on `PATH`, container-mode startup fails fast.
Install Docker or switch to `container.sandboxMode=host` to run without it.

Maintainer overrides:

- `HYBRIDCLAW_CONTAINER_PULL_IMAGE=<registry/image:tag>` forces a specific pull
  target
- `HYBRIDCLAW_CONTAINER_REBUILD=if-stale|always|never` adjusts rebuild policy
- `HYBRIDCLAW_CONTAINER_IMAGE=<name[:tag]> npm run build:container` builds and
  tags a custom image
- `HYBRIDCLAW_NO_SPINNER=1` forces the plain (non-animated) image-setup output
  even on an interactive terminal

Build context hygiene is enforced by `container/.dockerignore` to avoid shipping
local secrets or artifacts into published images.

Published images export with `rewrite-timestamp=true` under a fixed
`SOURCE_DATE_EPOCH`, so a step that reruns still yields byte-identical filesystem
layers when its content is unchanged. Registry-backed build caches avoid
repeating unchanged work, while each build emits fresh image metadata and
attestations for its commit. Without timestamp normalization, differing file
mtimes alone gave every layer a fresh digest and each upgrade re-downloaded the
whole image rather than a delta.

Published images also include the built `/chat`, `/apps`, and `/agents`
browser assets so the embedded web surfaces work from release images instead
of source checkouts only.

The gateway image installs the esbuild gateway bundle and its plugin SDK chunks
under `dist/`. Docker startup, the shell CLI, the package bin, and the embedded
terminal all use `dist/cli.js`. Both gateway and agent bundles inline
`container/shared`; the image does not ship that directory or plain gateway
`tsc` output. Source builds, npm packages, and desktop packages also run the
gateway bundle at `dist/cli.js`; `tsc` emits declarations beside it. A rebuild
keeps earlier content-hashed chunks so a gateway already running from the
checkout can still load its own lazily; `npm run clean` removes them, and
`prepack` cleans before packaging.
`tests/gateway-bundle-runtime.integration.test.ts` builds an isolated image
layout and checks gateway startup, CLI loading, plugin SDK identity, and the
embedded terminal when node-pty is available, without requiring Docker.

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
- `hybridclaw gateway status` and `!claw status` surface the active sandbox
  mode; in container mode they also show the configured image name, resolved
  version, short image id, and session count.

Dream consolidation always runs semantic-memory decay. Model cleanup runs only
when a workspace's `MEMORY.md`, selected daily-note content, or consolidation
language differs from its last completed cleanup. A `.memory-cleanup.sha256`
fingerprint in the host-mounted workspace survives gateway and worker restarts;
it records the resulting memory content so dream's own rewrite does not trigger
another cleanup. The first run without a fingerprint establishes this baseline.
Daily notes are preserved. Failed model calls use deterministic consolidation.

Private tool-history replay preserves short, nonliteral Python sorting
callbacks such as `key=ranker.get` and `key=lambda item: item.score`. Public
logs and exports keep strict credential masking; quoted key values, URL
credentials and structured authentication fields remain redacted in replay.

## Worker State

Host workers keep managed state in their owning agent's workspace, or the scope's
workspace for scoped chats. An execution workspace override changes tool paths
and the shell's working directory without moving bootstrap files, approval
stores, session state, visual snapshots or spilled tool results into task output.
The host runner sets `HYBRIDCLAW_AGENT_STATE_ROOT` to that owner directory;
Docker workers continue to use their mounted workspace for both purposes.
Transcript and compaction archive references use absolute paths when their files
live outside the execution workspace, so the read tool can still resolve them.

HTTP artifact read aliases (`/workspace/.http-artifacts/<filename>`) resolve
against the worker state root, independently of its execution directory. Reads,
vision analysis and attachment validation use the same resolver. The alias
rejects traversal, links and roots outside the existing allowlist; it grants no
write access and never searches another state directory or project cache.

Visual reads retain content-addressed snapshots in the owning state directory.
When the primary model cannot receive pixels, dispatch offers the existing
`vision_analyze` tool a durable `snapshot` reference. For a PDF, `page` selects one
original page per call; a standalone image needs no page number. The helper uses
the configured vision policy and requires visual-data delivery permission.
It validates snapshot ownership, selection, integrity and the existing image
size limit. Temporary render files can be removed before analysis, and a
replacement worker can use the same reference. Missing or changed evidence
requires reading the original file again.

For isolated host evaluations, an operator can set
`HYBRIDCLAW_EVAL_WORKSPACE_ROOT` to an existing absolute task directory. Only
OpenAI-compatible requests with an explicit eval profile use it. The directory
must be separate from the agent workspace, including through symlinks. HTTP
clients cannot select this path. The agent retains its default bootstrap and
skills, and the execution workspace fence remains enabled. Changing this setting
requires a new eval session; it is not a way to alter an active worker's roots.

### Interrupted Turns

Before worker dispatch, the gateway commits the user message and an unfinished
assistant placeholder to SQLite. Normal completion replaces those provisional
rows and removes the pending marker in one transaction. After a gateway restart,
the next turn recovers that session's checkpoint before building model context.

Workers write `turn-checkpoint.json` in the protected session state directory
under `.hybridclaw-runtime/sessions/<session-key>/`. The checkpoint records model
tool requests before execution, execution starts before invoking tools, and each
completed result immediately, including individual results in concurrent batches.
Large completed results retain a bounded excerpt and their durable full-result path,
so recovery preserves evidence without restoring oversized model context.
The last complete assistant message is retained too. Once a run has proposed tools,
a killed worker's replacement returns its evidence for the same run ID without
calling the model or tools. Runs with no proposed tools remain safe to retry.
A new run starts a fresh checkpoint; recovered exchanges are conversation context,
never executable instructions or approval grants.

A started call without a saved result has an **unknown outcome**: its side effects
may already have occurred. Recovery marks it explicitly and asks for external-state
verification before retrying. A proposed call that never started is marked **not
executed**. Recovery after interruption never applies queued gateway side effects;
authoritative error replies retain their results and queued effects. Missing or
corrupt journals retain the gateway's uncertainty placeholder;
unreadable journals refuse worker replay. Recovery readers reject links and enforce
the configured IPC output size limit. These atomic checkpoints cover abrupt process
termination, not power-loss durability or exactly-once execution of external APIs.

Risk boundary: checkpoint persistence must succeed before a tool starts. A crash
between an external effect and its result checkpoint cannot prove success or failure,
so recovery must never automatically repeat that call. The protected state remains
subject to the existing approval-state guard; it confers no execution authority.

Large tool results live in `.tool-results/` in the owning state workspace.
Their file paths travel with bounded model excerpts, so a replacement worker
can read or search the complete text without restoring it into model context.

The shell-denial replan budget uses the current request's tool execution records.
It grants one replan per request, not per session; it does not persist across
requests or authorize execution after worker replacement.

Trusted dispatches can set `toolCallLimits`, a map from exact tool names to
maximum execution attempts. The worker reserves each attempt synchronously
before execution and persists counts under its protected session state directory
in `tool-call-limits-<run-key>.json`. Replacement workers with the same run ID
inherit those counts; a new run receives its own budget. Missing or corrupt
state during execution fails closed. Limits do not grant tool access or approval,
and failed attempts still consume budget.

Session approval grants are written through to
`.hybridclaw-runtime/sessions/<session-key>/approval-session-trust.json`.
A replacement worker reloads them; switching sessions clears the prior session's
grants. These files use the existing pinned approval-state protections.


Rejected `write` preconditions persist canonical file paths in
`.hybridclaw-runtime/sessions/<session-key>/file-write-conflicts.json`.
Until a checked write or edit succeeds for that file, non-green or write-intent
Bash calls and deletion of that file or its parent require one-time approval,
including in full-auto and evaluation sessions. This deliberately fences opaque
scripts as well as direct redirects; unrelated shell mutations may also pause.
Read-only diagnostics, including an `echo` fallback after a read-only command,
and writing a separate deliverable remain available. File redirections and
opaque script execution still require approval while a conflict is unresolved.
Recovery diagnostics list the unresolved paths; writing a separate file leaves
the script-execution restriction in place. A checked mutation resolves only its
own path. Replacement workers reload the conflicts. Corrupt or unreadable guard
state and persistence errors fail closed; these records contain paths, never file contents.
The existing pinned approval-state rules protect this directory.

File-delivery guidance asks the agent to parse structured data and check the
requested structure after its final edit. This read-only QA is part of completing
the requested deliverable; optional builds, tests and generated-code execution
still require a request. This is model guidance, not automatic format enforcement
by the text-editing tools, and existing command permissions continue to apply.

### Auxiliary Model Routing

Browser vision and auxiliary tools share one model context and task-policy store
in `container/src/model-context.ts`. Each request rebuilds it from `ContainerInput`,
including the provider method, model behavior, and local-model parsing settings.
Tool calls capture routing and header snapshots before calling auxiliary models.
Disabled auxiliary tasks carry an explicit denial through worker IPC. Their
calls stop before provider fallback or network access; primary conversation
routing remains a separate setting.
This state lives in worker memory and is rebuilt when a worker is replaced.

### Browser Live Frames

After successful page-changing calls, local browsers and gateway browsers
with live frames (mac-cua) attach `browser: { url, title, frame }` to the tool
finish event in the chat stream.
Clients can retrieve `frame` through `/api/artifact`; it names a small viewport
JPEG in the workspace. The frame directory retains the latest 24 images.
Reported URLs include origin and path, with queries and fragments omitted.
Set `BROWSER_LIVE_FRAMES=false` in the worker environment to disable frames.

Secret typing pauses frames until the page URL changes. Page identity,
snapshot refs, and this pause live in worker memory; they are lost on worker
replacement, including when a gateway-owned browser window survives. Refresh
the snapshot before using element refs after a restart. Checkout actions require
one-time approval in every mode; see [Browser checkout](./approvals.md#action-reference).

A take-over (`browser_take_over`) lives in gateway memory and in the waiting
tool call. The worker restores its viewport when the take-over ends; a worker
replaced mid-take-over loses it, and the gateway drops it after 10 minutes.

### Shell Execution

Bash commands run asynchronously so tool activity heartbeats and worker signal
handlers remain responsive. The worker retains at most 4 MiB of combined stdout
and stderr; exceeding that limit cancels the command and returns partial output
with an error. Timeouts and graceful worker shutdown send SIGTERM to the command's
process group, then SIGKILL after 250 ms, including descendants that ignore
SIGTERM. Task sandboxes receive those signals inside the container rather than
only losing their local `docker exec` client.

Active command handles and process-group identities live in worker memory and
are discarded after the command finishes. Persistent shell snapshots and fresh
credential delivery follow the persistence boundaries below. Cancellation can
stop the wrapper before it saves changes made by that command to shell state.

### Persistence Boundaries

A session's turns run in a worker: an agent container in `container` mode, an
agent process in `host` mode. Workers are disposable, and one can exit between
any two turns:

- after 5 idle minutes;
- when a change of provider, credentials, or runtime environment alters the
  worker signature (switching models within one provider does not);
- when a new worker needs a slot at `container.maxConcurrent` and the least
  recently used worker has been idle for 10 seconds;
- when a plugin releases the session after its conversation ends (a voice
  call hangs up), once the running and queued turns finish;
- on a crash or a gateway restart.

The next worker is rebuilt from `ContainerInput`, so anything a later turn
needs lives on the gateway side: gateway storage or the host-mounted
workspace. Per-session facts go in the session state dir,
`<workspace>/.hybridclaw-runtime/sessions/<sha256 of the session id>/`, which
agent archives skip and `reset yes` removes with the workspace.

| State | Lives in | When the worker exits |
| --- | --- | --- |
| Safety-rule configuration | Gateway runtime config; authenticated snapshot on every worker input | Rebuilt each turn; absent settings restore all guards |
| Conversation, session settings, usage, audit trail | Gateway SQLite and data dir | Kept |
| Agent files, memory, transcripts, artifacts | Workspace | Kept |
| Pending approvals, `yes for agent` and `yes for all` trust | Workspace `.hybridclaw/` and `approval-trust.json`, shared by the agent's sessions | Kept |
| `yes for session` trust | Worker memory | Lost; the action asks again |
| Open boost question (offer, tool call, expiry) | Session state dir `pending-boost.json` | Kept |
| Files that `curl` or `wget` saved (fetched-code guard) | Session state dir | Kept |
| Bash working directory | Session state dir | Kept |
| Bash exported variables, aliases, activated virtualenvs | Worker temp dir | Lost; the first bash result in the next worker says so |
| Previously attached media paths authorized for read | Gateway conversation metadata, passed on every input | Rebuilt; original cache files can still expire |
| PDF page snapshots | Workspace `.visual-snapshots/`, content-addressed JSON | Retained; tool history references reconstruct native PDF or images after restart |
| Original in-loop compaction messages | Session state dir `in-loop-compactions/` | Kept; replacement summaries carry the file path |
| Background processes, `/tmp` files | Worker | Lost |
| IPC directory watcher and pending wakeup | Worker, per input wait | Closed after each wait; replacement workers scan existing files before waiting |
| Browser cookies, local storage, logins | `data/browser-profiles/` on the gateway host | Kept |
| Open pages and element refs, local browser | Worker | Lost; the next browser call starts a fresh browser |
| Open pages, plugin browsers (`managed-cloud`, `mac-cua`, ...) | Gateway | Kept |
| Page parked for 2FA, local browser | Worker | Lost; `browser_resume_interaction` fails and leaves the operator's reply unused |
| Which 2FA request a managed page is parked on | Worker memory | Lost; `browser_resume_interaction` then needs the `suspended_session_id` from the park result |
| MCP connections and scheduling declarations | Worker | Reconnected and revalidated from gateway config on the next turn; an idle warm worker connects them before its first turn |
| Web fetch and search caches, approval counters, seen hosts | Worker memory | Lost; later calls may ask again |

Exported variables stay in the worker on purpose: the shell snapshot holds the
whole environment, gateway token included, and must not be written to the
workspace. `AGENTS.md` §3.7 has the rule for adding worker state.

## Configuration Internals

HybridClaw runtime configuration is typed and validated in
`~/.hybridclaw/config.json`, which is auto-created on first run. Use
`config.example.json` as the reference. It is generated from
`DEFAULT_RUNTIME_CONFIG` plus a small overlay of example values by
`npm run generate:config-example`; `npm run lint` fails when it is stale, so
change defaults in `src/config/runtime-config.ts` and example-only values in
`scripts/generate-config-example.ts`, never the JSON file.

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
- Selected runtime config fields can use store-backed SecretRefs instead of
  plaintext values, and `tools.httpRequest.authRules[]` binds URL prefixes to
  gateway-injected secret headers for the `http_request` tool. New
  configuration should use `{ "source": "store", "id": "SECRET_NAME" }`;
  legacy Browser Use Cloud env refs are migrated to stored refs.
- Some settings still require restart, such as bind host and port.
- A default HybridAI chatbot is optional, set with `hybridai.defaultChatbotId`.
  Without one, HybridAI calls run on the model alone; RAG needs a chatbot.
- Agents are configured under `agents.defaults` and `agents.list`. Sessions bind
  to an agent, and that agent owns the workspace under
  `~/.hybridclaw/data/agents/<workspace>/workspace/`.
- `hybridai.maxTokens` sets the default completion budget per model call.
- Trust-model acceptance is persisted under `security.*` and enforced before
  runtime start. In non-interactive shells, `HYBRIDCLAW_ACCEPT_TRUST=true` can
  persist acceptance automatically before credential validation runs.
- `ops.webApiToken` (and the `WEB_API_TOKEN` env var) gate the built-in
  `/chat`, `/apps`, `/agents`, `/admin`, and admin API surfaces when set.
  Treat this bearer token as an operator master token: admin API calls
  authenticated with it are not narrowed by session-scoped admin action claims.
  Session claims such as `secret.overwrite` and `secret.unset` apply to
  browser/session-authenticated admin requests.
- `ops.gatewayBaseUrl` plus `ops.gatewayApiToken` let local clients such as the
  TUI, eval runner, and gateway command client target a different
  already-running HybridClaw gateway.
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
- Approval system, trust scopes, and workspace-local policy:
  [Approvals](./approvals.md)
- Scheduler jobs: SQLite-backed jobs with cron, every, at, or `one_shot`
  delivery targets (`one_shot` jobs run immediately, retry up to
  `maxRetries`, and land in review on success or terminal failure).
  `webhook` delivery posts only to public `https://` URLs, never follows
  redirects, and signs every body with the stored `SCHEDULER_WEBHOOK_SECRET`
  in `X-HybridClaw-Signature: t=<unix seconds>, v1=<hex HMAC-SHA256 of
  "<t>.<body>">`; receivers should reject signatures older than five minutes.
- Memory compaction and consolidation: `sessionCompaction.*`, `memory.*`
- Session continuity and DM isolation: `sessionRouting.*`
- Skill availability: `skills.disabled`, `skills.channelDisabled.*`
- Browser stealth allowlisting: workspace `browser.stealth.rules`
- Adaptive skill observation/amendment loop: `adaptiveSkills.*`
- Proactive runtime: `proactive.*`, including
  `proactive.delegation.model` for a dedicated delegate model
- MCP server registry: `mcpServers.*`
- Plugin overrides: `plugins.list[]`
- Observability export: `observability.*`
- Skills roots: `skills.extraDirs`

## OpenTelemetry Tracing

HybridClaw's built-in OpenTelemetry support is off by default. It turns on when
either `OTEL_ENABLED=true` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

Supported environment variables:

- `OTEL_ENABLED=true` enables OTel explicitly
- `OTEL_EXPORTER_OTLP_ENDPOINT` points at the collector and also enables OTel
- `OTEL_EXPORTER_OTLP_PROTOCOL` selects `grpc` (default) or `http/protobuf`
- `OTEL_SERVICE_NAME` overrides the reported service name (default:
  `hybridclaw-gateway`)

When enabled, HybridClaw emits spans for gateway message handling, agent runs,
host or container execution, skill loading, and every tool execution
(`hybridclaw.tool.execute`, nested under the turn span, with the tool name in
`hybridclaw.tool_name` / `gen_ai.tool.name` and `langfuse.observation.type=tool`
so Langfuse shows it as a TOOL observation). Structured logs also include
`traceId` and `spanId` fields so logs and traces can be correlated in the same
incident workflow. The OTel SDK is loaded lazily, so there is no startup or
runtime overhead when tracing is off.

## Sentry Error Reporting

HybridClaw can send gateway error traces to Sentry when `SENTRY_DSN` is stored
with `hybridclaw env set SENTRY_DSN <dsn>`. The integration captures startup
failures, uncaught exceptions, unhandled rejections, and errors recorded through
shared gateway/agent spans. It is disabled by default and flushes pending events
during gateway shutdown.

Supported environment variables:

- `SENTRY_DSN` enables Sentry and sets the project DSN; set it with `hybridclaw env set SENTRY_DSN <dsn>`
- `SENTRY_ENVIRONMENT` optionally overrides the Sentry environment; the default is `production`
- `SENTRY_RELEASE` optionally overrides the Sentry release name; the default is `hybridclaw@<package-version>`
- `SENTRY_TRACES_SAMPLE_RATE` optionally enables Sentry transaction sampling with a value from `0` to `1`; set it with `hybridclaw env set SENTRY_TRACES_SAMPLE_RATE <rate>`
- `SENTRY_USER_ID` optionally attaches a stable pseudonymous deployment user ID to every event; it is read only from the process environment so stored runtime settings cannot replace an operator-provided identity

Process environment variables with the same names are fallback values when no
runtime env value is stored, except `SENTRY_USER_ID`, which is process-only.

HybridClaw already owns OpenTelemetry setup, so the Sentry SDK is initialized
with its OpenTelemetry auto-setup disabled. Sentry events are passed through the
same secret-redaction helper used by other security-sensitive diagnostics
before they leave the gateway process. Gateway chat and agent/provider error
events include searchable Sentry tags for `session_id`, `agent_id`, and
`channel_id` when those values are available.

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

The gateway (`dist/cli.js`) and the agent runtime (`container/dist/index.js`)
are esbuild bundles, so stack traces name bundle chunks by default. The npm
package and the Docker image ship source maps beside them (desktop packages
strip them), but they are off because they slow startup; run with
`NODE_OPTIONS=--enable-source-maps` to get `src/` file and line numbers.

## Approval Explanations

Pinned-sensitive approval explanations identify policy pinning and the one-time
approval requirement, including for read-only operations. An unclassified shell
command is described as unclassified rather than asserted to mutate state.
The same reason is retained in the pending approval and returned evaluation;
this wording does not alter approval tiers or grant access.

## Tool Recovery

The system prompt distinguishes a failed method from a blocked task. It uses
current capability readiness, directs the model to investigate inconclusive
results and try materially different permitted methods, and bounds recovery by
useful progress and the remaining execution budget. Missing configuration does
not grant permission to obtain credentials or broaden access. Runtime blocks
and denied approvals must never be bypassed. Unread source content must not be
replaced with invented findings. Recovery may repair dependencies but must not
manufacture or replace authoritative messages, events, records or source
fixtures. Missing local files do not establish that a running service has no
data. Cached or exported data supports only its demonstrated scope and
freshness; reports must distinguish supported partial findings from complete
coverage and identify inaccessible sources. These are model instructions,
not runtime validation of arbitrary business data or connector coverage.

`tests/tool-recovery-prompt.test.ts` checks policy inclusion across prompt modes.
`tests/media-tools-readiness.test.ts` checks configuration snapshots and their
agreement with provider selection. The opt-in scripted model checks in
`tests/safety-guardrails.live.test.ts` cover recovery, completion after a
successful fallback, and preservation of denial boundaries; enable them with
`HYBRIDCLAW_RUN_LIVE_SAFETY=1`. By default they use the configured runtime
model and its provider transport and credentials, with retrieval disabled and
only synthetic scenarios. Proposed tools are inspected, never executed. To use
an explicit OpenAI-compatible endpoint instead, set both
`HYBRIDCLAW_LIVE_SAFETY_BASE_URL` and `HYBRIDCLAW_LIVE_SAFETY_MODEL` (plus
`HYBRIDCLAW_LIVE_SAFETY_API_KEY` when required).

## Prompt Context Assembly

HybridClaw separates the static system prompt from per-turn dynamic context.
`buildSystemPromptFromHooks()` should be byte-stable for the same agent,
selected prompt parts, tools, skills, and channel contract. Wall-clock data,
host metadata, today's and recent prior `memory/YYYY-MM-DD.md` notes, session
summaries, and retrieval snippets belong in the user-role dynamic context block
that is placed after retained conversation history, next to the latest user
turn.
History budgets drop a contiguous prefix of complete old turns; retained
messages are never sliced or rewritten.

The conversation on the wire is append-only. Each user message is stored with
the dynamic context it was sent with (`messages.dynamic_context`), and later
turns replay both, along with the turn's tool exchanges, so every request is a
prefix of the next. Providers that cache only whole earlier requests, such as
the HybridAI relay and OpenAI, then read the conversation history from cache,
not just the system prompt. For the same reason, the tool list and system
prompt depend on the agent, user, and client, never on the current message.

Anthropic requests keep the system prompt in volatility-ordered cache blocks:
static core instructions, workspace and durable memory, then skills. The
provider adds cache breakpoints at those boundaries and at the last stable
message content block. Turn-local dynamic context follows that message
breakpoint, so tool-loop iterations and later turns can reuse the unchanged
conversation prefix.

This split keeps provider prompt-prefix caches effective without removing
useful turn-local context from the model. It also gives trace exports a stable
`system_prompt_hash` plus separate `dynamic_context_hash` and `prompt_prefix`
entries so cache behavior and prompt composition can be audited per turn.

When adding a prompt hook, keep durable instructions in the system prompt and
put volatile facts in dynamic context or retrieval. Avoid reading clocks,
hostnames, randomized values, live memory files, or current-session summaries
from code that contributes to the static system prompt.

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

Gateway chat serializes turns by session id, and the host/container runners
apply the same per-session guard at their execution boundary. Different
sessions can still run concurrently. Interactive input preempts an active
full-auto turn before it waits on the session queue, so operator intervention
does not sit behind the autonomous run it is meant to stop.

## Web Surfaces And API Auth

HybridClaw's built-in browser surfaces share one auth model:

- `/chat` is the end-user chat UI
- `/apps` stores generated HTML apps and live connector-backed views
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
- a streaming `/api/chat` client that sends `toolStatus: true` declares that it
  shows `text` written before a `tool` start as a passing status and keeps
  only the text after the last tool as the reply (the `result` carries only
  that part). The agent is then asked to begin each tool-calling response with
  one short line such as "Checking the page…" instead of calling tools silently
- a client that sends its own note to the agent through `/api/chat`, such as
  "I saved my sign-in for example.com. Please continue." after the user acted
  in the app, sets `appNotice: true`. The agent reads `content` as usual, but
  the stored message is tagged `app-notice` and `/api/history` leaves it out,
  as it does for approval answers, so clients never hide turns by their wording
- `/api/history` also omits user turns stored by the scheduler. Scheduled
  prompts remain in persisted agent context and audit records; only their
  visible assistant replies appear in chat, including for existing runs.
- Hy clients choose emoji reactions separately from the main chat model, using
  the phone model first and `auxiliary/quick_decision` second. No suitable emoji is
  a valid decision. `POST /api/chat/reaction` persists an emoji (or null to remove
  it) on a message in the caller's bound session: `role: "user"` is Hy's reaction;
  `role: "assistant"` (the default) is user feedback. Only feedback can become a
  👍/👎 response rating. The main chat model has no `react` tool, and emoji-only
  replies remain reply text. `/api/history` returns persisted reactions.
- Raw, non-streaming `/v1/chat/completions` requests to
  `auxiliary/quick_decision` (or `auxiliary/eval_judge` from older app builds)
  use `auxiliaryModels.quick_decision` without provider fallback; with no model
  configured they use the default model, and a failed call returns 503
  `auxiliary_unavailable`. `model: "regular"` uses
  the default agent's regular model. Both use only the supplied messages and
  expose no tools. Avatar selection and idea categorization advance explicitly
  from the on-device model to auxiliary to regular when an answer fails validation;
  emoji selection ends after auxiliary. Cloud decisions require the app's AI consent.
- a streaming `/api/chat` response opens with an `accepted` line and sends a
  `ping` line after 15 s without other output, so proxies and phone read
  timeouts keep the connection open. Clients skip line types they do not know.
  The turn does not depend on its connection: if the client drops, the turn
  keeps running, is stored, and sends its "finished" notification. Only
  `/stop` ends it early. When the same caller resends the same body while the
  turn runs, the resend joins that turn. It gets every line so far and then
  the rest, so the message is not answered twice
- a streaming `/api/chat` client that sends `client: "mobile"` gets a `result`
  line with only `status`, `result`, `error`, `toolsUsed`, `sessionId`,
  `userMessageId`, `assistantMessageId`, and `artifacts`, plus `emailDraft`,
  `sessionTitle` and the chat's `scope` when the turn has them. Tool
  arguments and outputs, usage, prompts, and routing are left out; the `tool`
  lines already reported each call
- the first turn of a session starts its auxiliary title request once routing
  has accepted the turn, so it runs alongside the model call. The success `result` carries `sessionTitle` only when
  the title was ready before the reply; the turn never waits for it. The title
  is stored once it arrives, and only when the turn succeeded

## Scopes

A scope is a named compartment for side chats ("Work", "Family"). A scoped
chat knows who the user is (name, language, timezone) and what its scope's
chats learned, nothing from the main chat, unscoped chats or other scopes. The
main chat sees everything, every scope included. Scopes live in the `scopes`
table, never in a file the agent can edit, and only the user makes them:

- `GET /api/scopes?agentId=<id>` → `{ "scopes": [Scope] }`
- `POST /api/scopes` with `{ "agentId", "name", "connectors": [] }` → `Scope`
  (201). Names have 1–40 characters and are unique per agent, ignoring case
  (409, `errorCode: "scope_exists"`).
- `PATCH /api/scopes/<id>` with `{ "agentId", "name"?, "connectors"? }`
- `DELETE /api/scopes/<id>?agentId=<id>` → `{ "deleted": true }`, and the
  scope's workspace (memory, notes, transcripts) is erased.

`Scope` is `{ id: "s_<12 hex>", name, connectors, createdAt }`. `connectors`
holds platform connector ids as `/api/v1/connectors/directory` names them,
plus `"device"` for the phone's on-device data. The routes need `chat.send`,
like `/api/chat`.

`/api/chat` (and a voice call's `start` frame) takes `scope`. A session takes
it once, from the first request that names it, as long as it had no model
turn; commands the app sends first count. Later requests' `scope` is ignored,
the main chat (`main-…`) is never scoped, an unknown id answers
`errorCode: "unknown_scope"` and a chat whose scope was deleted answers
`scope_deleted` without running anything. Results of a scoped chat carry
`scope`.

Every run of a scoped chat (turns, the pre-compaction flush, its isolated
scheduled tasks and its subagents) uses `<agent workspace>/scopes/<id>/`: its
prompt files, daily notes, transcripts and the worker's `/workspace` mount.
AGENTS, SOUL, IDENTITY, TOOLS and the approval policy are copied in when they
change; USER.md keeps only the name, language and timezone. Nightly
consolidation runs per scope. A scoped chat gets no canonical cross-chat
context, no memory plugin context or tools, only connector tools of its scope
and public catalog tools (`hybridai__*__*` blocked, its services exempted;
all of them when the directory cannot be read), and `device_data` only with
`"device"`. Its worker gets a runtime token bound to the scope, so its gateway
callbacks act only for that scope's chats. Scoped chats do not use the warm
pool. The main chat's `memory` search and `session_search` also read
`scopes/*/`.

Delegated children inherit the scope workspace, connector limits and runtime
token at every nesting level. While a child is running, its exact gateway-issued
ID can make a waiting delegation callback for that scope. This identity grants
no other session routes and expires when the call finishes, including failures.
Deleting the scope refuses further callbacks and nested execution.

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
- A turn that starts over a minute after a server's last tool listing lists
  its tools again first (5 s limit), so tools a server adds without a config
  change, such as HybridAI catalog tools, reach a warm worker. A server that
  fails to answer keeps its previous tools.

Provider tool caps are defined once in `container/src/tool-count-limit.ts`.
A capped request whose tools would exceed the cap defers every MCP tool
behind `tool_catalog`, and promotion of reviewed read tools stops at the cap.
A request still over the cap fails without a model call. A provider `400`,
such as OpenAI's `array_above_max_length`, is not retried, and the turn error
carries the provider's message. Provider fallback reads the HTTP status, not
numbers inside that message.

Deferred MCP tools remain callable through `tool_catalog`. When connectors are
deferred, complete definitions up to 2,000 characters for reviewed read tools
are exposed directly, smallest first, after reserving space for deferred names.
The direct limit measures the whole definition; the index limit below measures
only the input schema. Review uses the same live/configured
trust and annotation checks as concurrent reads. Other connector tools and
bulky direct definitions use the catalog. The direct connector definitions and
remaining index share a 24,000-character budget; non-connector direct tools are
outside that budget. If names alone overflow, the directory reports the omitted
count and leaves discovery available. The index includes complete input schemas
up to 2,000 characters with its remaining space. `action=list` uses a separate
24,000-character schema budget and requires no `name` argument. The model can
execute those tools with
`action=call` without a separate `describe` response. Larger schemas keep the
explicit `describe` step. Discovery does not change the request's exposed
functions, argument validation, permissions or approvals. Invalid catalog actions
receive corrective tool results within the shared two-correction limit per
request. No call in a rejected batch executes; earlier completed calls remain
in history. Reconnects and trust
config changes can change exposure on the next request, invalidating cached
tool prefixes; a failed replacement never grants the old connection new trust.
Routine lookups use
available tools directly; skill discovery is for requested skills or specialized
workflows. An applicable listed skill is read before its first operation,
including when a workbook or document is an input to a broader task. Workspace
discovery uses scoped `glob`, `grep`, and `read` calls. Independent reads stay in
separate tool calls so a shell approval gate cannot hold up an unrelated read.
This is planning guidance, not an approval exemption: required approvals still
pause execution, and recursive shell searches that can reach pinned files
still require approval. Tools that accept multiple identifiers should fetch
independent items in one request within the tool's limits.

Shell safety hard blocks run before approval resolution and again at execution.
They cannot be overridden by a user approval, so prohibited commands produce a
denial without creating a pending approval. The first such denial in a request
returns to the model once to plan work that omits prohibited effects. Remaining
calls in that batch are marked unexecuted; every new call still faces the same
policy. A second shell hard block ends the turn, as do other policy denials.
Pending human approvals still pause execution.
Generation and verification run separately from necessary cleanup. Agents leave
disposable scratch files alone unless cleanup was requested or is needed for the
result; ordinary housekeeping does not delay delivery or turn success into a
failure message.
Approval clarification replies retain their text in Teams alongside the existing
choices and expiry; asking a question neither grants consent nor extends expiry.
The hard-block patterns are unchanged and commands are never rewritten or split
by this check. Clarification text is escaped for display and cannot alter the
stored executable call, allowed scopes, or permission decision.

MCP calls are serial barriers by default. Operators can declare trusted read
behavior under a server's `toolBehavior` configuration:

```json
{
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "toolBehavior": {
    "trustAnnotations": true,
    "overrides": {
      "lookup_messages": "read-only",
      "send_message": "mutation"
    }
  }
}
```

`trustAnnotations: true` admits tools with an explicit `readOnlyHint: true`
from that server. Enable it only after reviewing the server's behavior and
annotation source. Exact overrides use the original discovered tool name
(without HybridClaw's server prefix); `read-only` can admit an unannotated tool,
and `mutation` keeps it serial even if the server calls it read-only. Names,
descriptions, idempotency hints and non-destructive hints never establish read
safety. A `readOnlyHint: false` or `destructiveHint: true` always keeps a tool
serial, including when an override claims otherwise.

The auto-added `hybridai` connectors server declares the reviewed
`web_search`, `dm__searchProducts`, and `dm__getProductDetails` contracts as
`read-only`, so independent searches and product lookups can overlap. This
does not trust annotations from other broker-proxied tools. Entries under
`mcpServers.hybridai.toolBehavior` are kept, and their overrides win.

Trusted reads share the existing limit of eight calls per batch with built-in
tools. Results remain in model order; mutations and unknown tools drain the
preceding batch and run alone. Required or denied approvals stop batch
preparation at that call: these declarations do not grant permission or change
approval tiers. Server-specific rate limits still apply; omit trust or use a
`mutation` override when a tool must run serially.

Risk boundary: a lying trusted server or an incorrect operator declaration can
cause side effects to overlap. Trust is explicit and disabled by default. Both
the live connection and the requested config must admit overlap, so a failed
replacement cannot broaden the old connection's trust, and revocation takes
effect even if reconnect fails. Discovery and config are rebuilt after worker
replacement; no session-only trust decision is retained.

Skill routing metadata uses a one-line catalog with its 30,000-character entry
budget. Default bundled paths are stated once; custom paths remain explicit.
Descriptions shorten before names are omitted, and `skills_list` retains the
complete directory. Always-on skill bodies keep their separate 10,000-character
budget. System prompt and tool schemas stay stable throughout a request.

Tool results above 16,000 characters are saved in full under
`.tool-results/<session>/<tool-call>.txt` in the owning state workspace. Model
input and replay receive an 8,000-character head/tail excerpt plus the saved
path. Full evidence still crosses IPC by reference and is restored for audit
and transcript storage. Results remain available until workspace reset; worker
replacement and compaction do not remove them.

Use `read` with `path`, `char_offset` (zero-based), and `max_chars` to page
through saved text, including single-line JSON. `read` with a literal `query`
returns a matching excerpt and its character offset; use `char_offset` to
continue searching. These reads return at most 2,000 excerpt characters.
The existing workspace and approval checks apply to every read.

The context guard measures pressure without rewriting tool results. In-loop
compaction sends every selected message intact to the compression model,
including tool calls, results, structured content, and the schemas needed to
interpret historical tool calls. Summarization never executes those tools. It archives the original
region in the persistent session state dir and includes that file's path in the
replacement summary. Replacement must reduce the estimated token count,
including its label and archive reference, before any archive is written.
Failed, empty, or length-truncated summaries, archive write failures, and
summaries that do not shrink the region never authorize dropping messages.
If compaction cannot progress, including when the newest exchange leaves no
compactable middle, the loop saves oversized tool results and reduces their
inline excerpts to fit the active context budget. Call/result pairing and full
on-disk evidence remain intact. A failed result-file write leaves the original
result in context; the loop reports exhaustion if it still cannot fit. Each
rejected attempt logs a distinct reason without logging response text or error payloads.

Successful maintenance compactions do not spend `sessionCompaction.inLoopGuard.maxRetries`.
That limit bounds consecutive provider context-window recovery retries and resets
after an accepted loop request, not after a summary. Compaction stops immediately
when it cannot produce a smaller archived replacement.

The compression model needs enough context for the complete selected region,
its historical tool schemas, and the summary output budget. It falls back to
the active model when no compression override is configured. For long tasks,
configure `auxiliaryModels.compression` with sufficient capacity; a larger
window than the active model helps recover even when that model overflows.
An input rejected as too large reports `summary_context_overflow`; the loop
then attempts the disk-backed result recovery described above before reporting
context exhaustion. Archives contain conversation and tool data that the agent
can read; private file permissions protect against other host
users, and workspace reset removes them.
The concise summary target is separate from the generation allowance, which
includes a reasoning model's thinking tokens. Compression defaults to 8,192
generation tokens, bounded by the model's output capacity and estimated input
headroom; `auxiliaryModels.compression.maxTokens` overrides that allowance.
The summary target stays at up to 1,024 tokens. A truncated generation still
cannot replace the original evidence.
The former `sessionCompaction.inLoopGuard.perResultShare` setting is removed;
remove it from custom configuration. Inline tool-result bounds are fixed
runtime limits rather than configuration.

`web_fetch` and `web_extract` accept readable text, HTML, JSON and XML. Known
binary responses fail with a download continuation instead of entering model
context as text. If available, `http_request` with `responseArtifact` saves the
file for `read` or a permitted skill; choose a bounded `maxResponseBytes` large
enough for the file. PDF and image inspection use the existing local-file tools.
Oversized HTTP responses are cancelled without saving a partial artifact. The
artifact error reports the limit and declared or received size so the caller can
choose an explicit bound for a retry; the gateway does not raise it automatically.

When a fetch body or extracted text reaches its size limit, the tool identifies
the source as incomplete before the returned content. This warning also applies
to cached results and auxiliary summaries. A saved tool-result file contains the
retained extraction, not any source content discarded at the fetch limit.

When Readability omits context outside its selected article, `web_fetch` retains
an explicitly labeled leading excerpt from a main HTML landmark. It excludes
navigation, sidebars, scripts and explicitly hidden markup; the existing output cap still
applies. This preserves supplied page status and dates without interpreting them
or promising a complete page rendering. Context already in the article is omitted.
Extraction-failure hints assess the article itself, excluding that added context.

`web_fetch` escalation hints describe extraction limits, not necessarily access
denials. A JavaScript app shell should be retried at the same URL using browser
navigation; another search does not render it. Protection scripts alone do not
establish bot blocking. HTTP 403/429 or visible challenge text still yields
`bot_blocked`; private-network and redirect guards remain enforced.

YouTube video links (`watch`, `youtu.be`, `shorts`, `live`, `embed`) skip
readability, which only finds the page footer: `web_fetch` reads title,
channel, date, duration, views and description from the watch page's player
JSON. When the page is walled, it returns oEmbed title and channel and says the
description could not be read.

## Audit Trail Internals

HybridClaw records forensic audit events by default:

- append-only session wire logs:
  `~/.hybridclaw/data/audit/<session>/wire.jsonl`
- tamper-evident hash chain from `_prevHash` to `_hash`
- normalized SQLite tables: `audit_events` and `approvals`
- appends queue in call order and are group-committed off the event loop
  (`src/audit/audit-trail.ts`); a record reaches `audit_events` only after its
  wire line is fsynced, and gateway shutdown drains the queue before closing
  the database
- model calls to the `hybridai` provider carry `X-HybridClaw-Session-Id`,
  `X-HybridClaw-Run-Id`, `X-HybridClaw-Agent-Id`, and `X-HybridClaw-Channel-Id`
  headers whose values match the `sessionId` and `runId` of the wire log, so
  backend traces of one turn can be linked to the local audit trail. Turns from
  the mobile app (`client: "mobile"` on `/api/chat`) also carry
  `X-HybridClaw-Client: mobile`
- first-run `BOOTSTRAP.md` hatching emits structured `onboarding.*` events
  for lifecycle state, visible messages, welcome mail, workspace file updates,
  completion, and abort paths

Useful maintainer commands:

- `hybridclaw audit recent 50`
- `hybridclaw audit search "tool.call" 50`
- `hybridclaw audit approvals 50 --denied`
- `hybridclaw audit verify <sessionId>`
- `hybridclaw audit instructions`
- `hybridclaw audit instructions --sync`

Instruction runtime copies:

- file: `~/.hybridclaw/instructions/TRUST_MODEL.md` (read by onboarding for
  trust-model acceptance)
- source of truth: installed package file `TRUST_MODEL.md`
- `hybridclaw audit instructions` fails when runtime copies drift from installed
  sources
- `hybridclaw audit instructions --sync` restores runtime copies from installed
  sources and removes the retired `~/.hybridclaw/instructions/SECURITY.md`
- `hybridclaw tui` performs this check before startup

## Observability Push Internals

HybridClaw can forward audit-derived events to HybridAI ingest:

- endpoint: `POST /api/v1/agent-observability/events:batch`
- token source: `POST /api/v1/agent-observability/ingest-token:ensure`
- source table: local `audit_events`, ordered by `id`
- stream identity: the install's node id (`identity/instance-id.json` in the
  data dir), sent as `node_id` when the ingest token is requested
- agent: each batch carries one `agent_id`, taken from the run's durable
  `session.start.executingAgentId`. All events in that session/run use this
  identity, including app-generated session IDs and delayed uploads after an
  agent switch. Records without a captured execution identity retain the
  session-key/default-agent fallback; already exported history is not rewritten.
- persisted cursor: `observability_offsets`, keyed by ingest URL and node ID;
  cursors from other nodes and retired bot/agent keys are never reused
- cached ingest tokens: `observability_ingest_tokens`, reused until ingest
  answers 401/403, then rotated once with `rotate: true`

Runtime diagnostics:

- `GET /api/status` returns an `observability` status block.

## Local LLM Providers

HybridClaw can route agent turns to locally running LLM servers instead of
(or alongside) cloud providers. Four backends are supported:

- **Ollama** — default base URL `http://127.0.0.1:11434`
- **LM Studio** — default base URL `http://127.0.0.1:1234/v1`
- **llama.cpp** — default base URL `http://127.0.0.1:8081/v1`
- **vLLM** — default base URL `http://127.0.0.1:8000/v1`

Local backends are disabled by default and are probed only after an operator
enables them.

Enable and configure a backend with:

```bash
hybridclaw auth login local <backend> [model-id] [--name <endpoint>] [--base-url <url>] [--api-key <key>] [--thinking-format qwen] [--no-default]
hybridclaw auth status local
```

Runtime details:

- Configuration is stored in `~/.hybridclaw/config.json` under `local.*`.
- Each backend gets its own `enabled` flag and `baseUrl`.
- Additional same-type endpoints are stored in `local.endpoints[]`; endpoint
  names become model prefixes such as
  `haigpu2/mistralai/Mistral-7B-Instruct-v0.3`.
- Named endpoints carry a fail-closed privacy `zone` and can provide
  `pricing.inputEurPerMillion` / `pricing.outputEurPerMillion` for usage
  accounting. Missing zones resolve to `cloud`; missing prices stay unknown.
- Local models are prefixed with the backend name (e.g. `lmstudio/qwen/qwen3.5-9b`,
  `ollama/llama3`).
- Special model behavior is explicit in `modelBehavior`, for example
  `thinkingFormat: "qwen"`.
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

## Request-Scoped Agent Replies

Every executor request carries a random `requestId`. The agent writes its
reply to `output-<requestId>.json` in the session IPC directory (naming in
`container/shared/ipc-output-files.js`), and `readOutput()` waits for that file
only:

- A stopped agent's SIGTERM handler still answers its in-flight request, with
  the tool calls that ran and any delegations it had queued. The interrupted
  read waits up to 2 s for that reply and keeps only its tool history. A reply
  that lands later stays in the stopped request's own file, which no later
  request reads; the next request's `cleanupIpc()` deletes it.
- An interrupted container leaves the pool immediately, so the next turn starts
  a fresh container instead of reusing one that `docker stop` is still shutting
  down.
- Requests without an id reply in `output.json`; the gateway also accepts that
  file from agent images built before request ids.

## IPC Wakeups And Reconciliation

Both IPC readers watch the session directory before their first file check.
Directory notifications wake them promptly, including when an atomic reply
rename replaces a file. Notifications received between a check and a wait are
remembered, and repeated events coalesce. Event filenames and event counts are
never used to select or authorize a payload: readers recheck the expected paths,
verify follow-up input authentication, and keep replies scoped to their request.

Readers also reconcile from disk once per second, bounded by their idle and
wall-clock deadlines. This covers missing events and unavailable or failed
watchers on [Docker and virtualized filesystems](https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats).
Worker exit and shutdown state are checked on each wakeup or reconciliation;
gateway interrupts wake the output wait immediately. Watchers, wait timers, and
abort listeners close when the read finishes, including timeout and interrupt.
Machine-only input, health, and output JSON is compact.

This reduces gateway/worker handoff latency and idle filesystem checks. The
handoff occurs on reused-worker input and final replies; tool calls within a
turn do not each pay this cost. Expected savings are tens of milliseconds,
depending on notification delivery; missed events can take up to one
reconciliation interval to recover.

## Authenticated Agent Input

The agent's first request arrives on stdin, a channel the agent's own tools
cannot write. It carries a random per-worker secret that the gateway keeps in
memory and never writes to disk or the environment.

Every later turn arrives as `input.json` in the session IPC directory, which the
agent can also reach. So the gateway wraps each follow-up in an authenticity
envelope keyed by that secret (`container/shared/ipc-input-auth.js`), and the
agent runs a follow-up only when the envelope verifies against the secret it
received on stdin. Input it cannot verify is dropped, never run.

`health-input.json` is a liveness probe only: the agent reads just the nonce to
echo and never turns a health file into a turn, so it needs no envelope.

## Mid-Turn Steering

`POST /api/chat/steer` hands a note to the turn running in a session. The
agent makes an inbox directory, `steer-<requestId>`, in the IPC directory when
it takes a request of a user turn; the gateway delivers a note by renaming a
finished file into it, signed with the per-worker secret like follow-up input
(`container/shared/steer-inbox.js`). An agent image without steering makes no
inbox, so its turns refuse every note. The agent shows waiting notes to the
model:

- after the tool call (or parallel batch) that is running: calls of the same
  model step not yet started are answered `Not run`, and the note follows as a
  user message, so the model re-plans with it
- where the turn would end (a final answer, a reaction, a stall, an approval
  request or denial): the agent renames the inbox to `steer-<requestId>.closed`
  first and drains it. With notes it reopens the inbox, adds them as a user
  message and calls the model again; the reply so far stays the start of the
  reply. Without, the inbox stays closed and the turn ends.

A delivery after the close fails, so the route answers `accepted: false` and
the client sends the note as a turn of its own; one before it is drained. The
gateway also refuses notes once the request has returned, once `/stop`
interrupted it, under confidential redaction, and for automatic turns
(full-auto, goals, schedules, heartbeats, fan-out). A turn waiting for approval
has no running request, so notes go as turns; `yes <id>` answers still go
through `/api/chat`. Notes the model was shown are stored as user messages
between the turn's message and its reply. A note accepted just before the turn
fails or is stopped is dropped with the turn and not stored. When model routing
escalates, the next request starts from the turn's messages, so it is offered
every note of the turn again.

## Agent Shutdown

When the gateway stops an agent process, for example to interrupt a turn, the
agent receives `SIGTERM` (through `docker stop` in container mode). It writes
the interrupted reply to its in-flight request's reply file at once, keeping
the tool calls that already ran, and then closes its browser sessions and MCP
servers, which can take seconds. From the signal on, the agent starts nothing
new:

- no model call, tool approval, tool run, or later reply; a model or tool
  result still in flight when the signal arrives is dropped
- no `input.json` or `health-input.json` is consumed, because the replacement
  agent that the runner starts for the next turn can share the session's IPC
  directory

Each of these entry points checks the latch in
`container/src/shutdown-latch.ts`; a new entry point must check it too.

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
- `status` includes the current session agent and, when configured, delegate
  model usage and local-token share
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

`write` creates files exclusively by default. To replace an existing text file,
read its complete contents and pass `overwrite: true` and `expected_content`
containing those exact contents, including trailing newlines. A missing file or
content mismatch rejects the replacement without changing the target. Empty
files require `expected_content: ""`. After a stale-write error, read again and
reconsider the change instead of retrying with the old contents. Use `edit` for
targeted substitutions.

Successful `write` and `edit` calls check JSON syntax for `.json` files up to
256 KiB. Invalid JSON adds an advisory warning to the tool result; the requested
bytes remain saved, including intentionally invalid test fixtures. Larger JSON
files report that the automatic check was skipped. This checks syntax only,
not schemas or correctness, and does not apply to shell writes or other formats.

Publication is atomic, and cooperative `.lock` directories serialize `write`
checks and replacements across workers, including task sandboxes. These checks
use current disk state and survive worker replacement. A crashed writer's lock
fails closed until removed after verifying no writer is active. External editors,
`bash`, `edit`, and generated-artifact tools do not participate in this protocol;
a change they make during the check/publication window can still race a write.
These controls supplement existing path and approval checks.

Prompt and runtime internals:

- session compaction with pre-compaction memory flush: complete instructions
  are processed in bounded batches, duplicate failed requests are collapsed,
  and completion requires an append confirmed in the daily note or an explicit
  no-memory skip. Unverified saves defer compaction and automatic session reset;
  model claims alone do not mark the flush complete.
- prompt hook pipeline: `bootstrap`, `memory`, `safety`, `proactivity`
- hook config lives in `config.promptHooks`
- delegated agent runs persist request logs, audit tool events, and model
  usage under `delegate:d<depth>:<parentSessionId>:...` child session ids
- a delegated agent gets its parent's tools, MCP and plugin tools included,
  except `cron`, `memory` and the browser tools that wait on a user; a child
  that hits an approval gate reports `blocked` instead of asking
- `delegate` waits for its children and returns their reports as the tool
  result; with `background: true` the parent turn ends and a later
  `delegate:results` turn wakes the parent with the reports, hidden from
  history views
- Waiting delegation resolves an execution worker to its unique active
  conversation owner. Released, aborted or ambiguous worker aliases cannot
  identify a parent; no durable alias session is created.
- Each live delegated child has its own exact callback identity and model.
  Nested calls inherit that child's model unless the caller or configured
  delegate model selects another; a completed child's context is released.

## PDF reading

Current-turn PDF attachments and explicit local PDF paths receive a bounded
`[PDFPreview]` in user content, before confidential text redaction. The preview
contains up to four files, four pages per file and 6,000 text characters per
file, with original page numbers, omitted-page counts and truncation flags.
The preview is never a system instruction. Selected pages accompany it as native
PDF content on the official OpenAI Responses and Anthropic Messages endpoints.
Other endpoints, including Qwen/vLLM, Ollama, Codex and Gemini's OpenAI-compatible
API, receive rendered page images. Claude CLI receives text only. Vision support
and native PDF endpoint support are separate: known text-only models receive
text; unknown models negotiate image support through the endpoint. Explicit
media rejection retries native PDF → images → text, never after a streamed text
or thinking delta. Authentication, network and unrelated errors are not retried
by this fallback. Text-only delivery always reports unavailable visual coverage.

The existing `read` tool accepts `pages` (up to four pages per call) and `render`
(`auto`, `never`) for PDFs. Reads are capped at 50 MiB and 24,000 text
characters. `auto` delivers every selected page directly to the active
model, preserving charts even on text-rich pages; `never` requests text only.
No separate vision-model call is needed. Native uploads contain only selected
pages, with a mapping back to original page numbers. For full-document tasks,
read every relevant page batch. A page is not empty merely because extraction
returned no text.

PDF page and standalone-image snapshots live in workspace `.visual-snapshots/`, addressed by SHA-256. Tool
history stores validated references, not base64 payloads. Worker replacement
and provider changes reconstruct the appropriate representation from these
snapshots. Missing, modified or oversized snapshots produce an explicit coverage
warning and require re-reading the source. Each snapshot and each request's
visual payload are limited to 20 MiB; token estimates reserve 4,000 tokens per
selected page. Snapshots follow workspace retention and may be deleted when
retiring its history; deleting live snapshots makes those references unavailable.
Earlier attachment access is reconstructed from stored conversation metadata.

PDF reads use the normal read approval and sandbox boundary. Gateway-supplied
media paths are scoped to the session, never the entire media cache. Snapshot
loads accept hashes rather than paths, reject symlinks, validate size and verify
content integrity. Parsing uses the bundled, lazily loaded PDF skill runtime.
Document text and visuals remain untrusted user data. Confidential text redaction
disables binary PDF/image delivery, including historical snapshots and auxiliary
file/browser vision calls, because text redaction cannot sanitize document bytes
or pixels. The gateway sends visual-data permission independently of the primary
model's image capability. A text-only primary can use an otherwise permitted,
configured auxiliary vision model; a confidentiality block cannot be bypassed by
switching models. Both flags and tool-call permission snapshots are rebuilt from
each ContainerInput after worker replacement. Rendering or delivery alone
does not prove model accuracy; coverage and extraction/render errors stay explicit.

`read` searches PDF text with `query` (literal text, up to 256 characters),
returning page numbers and snippets before a separate `pages` read. Each search
covers at most 500 pages and 20 matching pages, reporting unsearched and sparse
pages. It does not OCR scans. The model chooses search queries and page selections
through `read`, using the attachment paths and conversation context. Automatic
previews cover the first four pages of current-request PDFs; they do not interpret
the user's question, search for captions, or select pages for follow-ups. Further
reads use the session-authorized attachment paths without shell conversion or
optional cleanup.

PNG, JPEG, GIF and WebP reads deliver normalized PNG pixels directly to the main
model using the same visual snapshot, replay and confidentiality boundary.
Inputs are capped at 10 MiB and output at 1600px; animated GIF reads cover only the
first frame. Unsupported binary files fail instead of producing UTF-8 garbage.
vLLM's “At most 0 image(s)” rejection is treated as unavailable vision; the
text-only response explicitly reports that the image could not be inspected.


### Mobile approval review facts

Pending approvals may include `reviewArguments`, a JSON string containing a
projection of the exact pending connector call. It is separate from the shortened
`commandPreview`, allowing mobile clients to review complete email bodies and
attachment names/paths before sending. Both IPC runners and the chat event retain
this optional field; a proxy serving phones must forward it unchanged.

The producer allowlists review fields and removes credential fields and attachment
bytes. Reviews larger than 256 KiB are omitted as a whole, never truncated into a
misleading partial message. Unknown or missing details remain unknown. The field
is presentation data: approval ID binding, expiry, execution arguments and allowed
grant scopes are unchanged. It carries message content over the existing private
approval transport and must not be included in diagnostic logging. Attachment paths
use the client's authenticated document reader; metadata without a path cannot
supply an attachment-content preview.
