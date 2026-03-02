# Changelog

## [Unreleased]

### Added

### Changed

### Fixed

## [0.1.18](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.18)

### Added

- **Forensic audit trail**: Added append-only wire logs at `data/audit/<session>/wire.jsonl` with SHA-256 hash chaining for tamper-evident immutability.
- **Structured audit storage**: Added normalized SQLite `audit_events` and `approvals` tables for searchable event history and denied-command reporting.
- **Audit verification and search CLI**: Added `hybridclaw audit recent|search|approvals|verify` command suite, including hash-chain integrity verification.
- **Instruction integrity CLI**: Added `hybridclaw audit instructions [--approve]` to verify and locally approve core instruction markdown hashes (`AGENTS.md`, `SECURITY.md`, `TRUST_MODEL.md`) via `data/audit/instruction-hashes.json`.
- **TUI instruction approval gate**: Added TUI startup enforcement that blocks on unapproved instruction changes and prompts the user for interactive approval.
- **Instruction approval audit events**: Added structured `approval.request` and `approval.response` events for instruction approvals (`action=instruction:approve`) so approvals/denials appear in the audit trail.

### Changed

- **Audit command routing**: Enforced audit operations as top-level CLI commands (`hybridclaw audit ...`) and removed gateway-audit passthrough ambiguity.
- **Policy document split**: Moved onboarding acceptance policy to `TRUST_MODEL.md` and repurposed `SECURITY.md` for technical agent/runtime security guidelines.
- **Runtime safety prompt source**: Runtime safety guardrails now include the `SECURITY.md` document content directly in the system prompt.

### Fixed

## [0.1.17](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.17)

### Added

- **Push-based delegation tool**: Added `delegate` side-effect orchestration so subagent tasks auto-announce on completion without parent polling.
- **Delegation runtime manager**: Added queue-backed delegation execution with configurable concurrency, depth, and per-turn limits.
- **Proactive active-hours policy**: Added configurable active-hours gating and optional off-hours queueing for proactive outbound messages.
- **Container extension hooks**: Added runtime lifecycle hook points around model/tool execution with a built-in proactive security hook.
- **Multi-mode delegation interface**: Added `delegate` modes for `single`, `parallel`, and `chain` (with `{previous}` step interpolation), plus per-task and per-run model overrides.
- **Delegation result metadata**: Added structured delegated completion transcripts with per-task status, duration, attempts, model, and tool usage, alongside concise user-facing summaries.
- **Automatic stale container rebuild detection**: Added startup fingerprint checks for container sources so `gateway`/`tui` can rebuild the runtime image automatically when stale.

### Changed

- **Prompt hook pipeline**: Added `proactivity` hook to explicitly guide autonomous memory capture, session recall, and delegation strategy.
- **Container resilience**: HybridAI requests now use bounded exponential retry for transient API/network failures.
- **Gateway status output**: `status` now reports live delegation queue activity.
- **LLM delegation guidance**: Parent system prompt now includes a full subagent delegation playbook (when to delegate, when not to, anti-patterns, context checklist, and decomposition heuristics).
- **Subagent prompt contract**: Delegated child sessions now receive explicit role/identity constraints and a required structured final output format (`Completed`, `Files Touched`, `Key Findings`, `Issues / Limits`).
- **Depth-aware delegation capability**: Non-leaf delegated sessions can orchestrate further delegation within max depth; leaf delegates are explicitly restricted.
- **Container startup policy**: Container readiness now defaults to `if-stale` rebuild behavior and supports env override via `HYBRIDCLAW_CONTAINER_REBUILD=if-stale|always|never`.

### Fixed

- **Delegation turn-budget accounting**: Depth-rejected delegations no longer consume per-turn delegation budget, preventing false limit exhaustion.

## [0.1.16](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.16)

### Added

- **Built-in browser toolset**: Added `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_back`, `browser_screenshot`, `browser_pdf`, and `browser_close` in the container runtime.
- **Browser runtime module**: Added a dedicated browser tooling layer with per-session socket isolation and normalized JSON responses for tool calls.

### Changed

- **Preinstalled browser stack in container image**: Container build now includes `agent-browser`, `playwright`, and preinstalled Chromium/headless-shell binaries for immediate browser tool availability.
- **Browser runtime hardening**: Browser subprocesses now use workspace-backed runtime/cache paths and explicit Playwright browser path wiring to avoid permission/cache issues across UID modes.
- **Docs updates**: Updated README and website docs tool catalog to include browser automation capabilities and preinstall behavior.

### Fixed

- **Browser tool startup failures**: Resolved `npm ENOENT/EACCES` and Playwright executable-missing errors observed during runtime tool execution in persistent containers.

## [0.1.15](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.15)

### Added

### Changed

### Fixed

- **Program creation workflow enforcement**: Implementation requests now enforce file-first behavior (write/edit on disk before response), disallow shell-based file authoring shortcuts (`heredoc`, `echo` redirects, `sed`, `awk`), and require explicit run/offer-run behavior after file changes.

## [0.1.14](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.14)

### Added

### Changed

### Fixed

- **Website build timeout regression**: Increased default container request timeout from `60s` to `300s` and upgraded `bash` tool execution timeouts (configurable per call) so longer build/test commands return actionable errors instead of premature timeout failures.

## [0.1.13](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.13)

### Added

### Changed

- **Release/version sync**: Bumped package and container versions to `0.1.13` after `0.1.12` npm publication.
- **Docs alignment**: Kept README/changelog aligned with the `config.json` runtime + `.env` secrets model.

### Fixed

## [0.1.12](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.12)

### Added

- **Website social metadata**: Added Open Graph and Twitter card metadata for `docs/index.html` so link previews render consistently.
- **Local favicon assets**: Added HybridAI favicon files under `docs/static/` and wired website favicon + Apple touch icon tags.

### Changed

- **Onboarding config persistence**: Default bot selection now persists to `config.json` (`hybridai.defaultChatbotId`) while `.env` is now treated as secrets-only.
- **Legacy bot-id migration**: Runtime now auto-migrates `HYBRIDAI_CHATBOT_ID` from `.env` into `config.json` when present and no configured default exists.
- **Onboarding/TUI color themes**: Added adaptive light/dark terminal palettes with readable high-contrast output on light backgrounds.

### Fixed

- **Default bot retention in onboarding**: Pressing Enter on bot selection now keeps the existing configured bot instead of silently switching to the first API bot.
- **Gateway bot guidance text**: Missing-bot errors now point to `hybridai.defaultChatbotId` in `config.json` instead of legacy env instructions.

## [0.1.11](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.11)

### Added

### Changed

### Fixed

- **Missing API key startup crash**: Import-time `HYBRIDAI_API_KEY` validation was moved to runtime access so `hybridclaw tui` now prints onboarding guidance instead of a stack trace when credentials are missing.

## [0.1.10](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.10)

### Added

### Changed

### Fixed

- **Postinstall hang during npm install**: Removed the root `postinstall` hook that could cause installs to stall.

## [0.1.9](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.9)

### Added

### Changed

- **Scoped npm install docs**: Updated docs install snippets and copy button text to use `npm install -g @hybridaione/hybridclaw`.
- **Postinstall setup flow**: Root `postinstall` now installs container dependencies and conditionally builds when source files are present.

### Fixed

## [0.1.8](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.8)

### Added

- **Live tool streaming in TUI**: Tool usage lines now stream with explicit tool names and emoji prefixes as they start, keeping operators informed during execution.

### Changed

- **TUI tool output formatting**: Tool usage output was restored with intentional indentation and compact summary replacement behavior.

### Fixed

- **Tool visibility regression**: Tool call logs are no longer swallowed into final output and are now shown at execution time.
- **Gateway startup messaging**: `hybridclaw tui` no longer prints verbose gateway logs during startup and now uses concise gateway presence/startup status messages.

## [0.1.7](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.7)

### Added

- **Live TUI tool progress streaming**: `hybridclaw tui` now displays tool execution starts as they happen via gateway streaming events.

### Changed

- **Tool output UX**: Tool lines now use a consistent jellyfish prefix and indentation, and interim tool lines are replaced with a final compact `tools` list after completion.

### Fixed

- **Tool usage visibility**: Tool calls are now shown during execution instead of only briefly at the end, so the operator sees `tool` usage flow in real time.

## [0.1.6](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.6)

### Added

- **Container image bootstrap in CLI**: `hybridclaw gateway` and `hybridclaw tui` now verify the `hybridclaw-agent` container image at startup and attempt `npm run build:container` automatically when missing.
- **User-friendly env var failures**: Startup now detects missing required environment variables and prints actionable hints instead of raw stack traces.
- **Simplified install flow**: Root `npm install` now drives container dependency setup through a dedicated setup script, so users no longer need a separate container install step in the quickstart.

### Changed

- **Onboarding runtime checks**: The CLI command flow now includes a shared container-readiness guard for startup paths, with non-interactive-friendly behavior.

## [0.1.5](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.5)

### Added

- **Explicit trust-model acceptance in onboarding**: Added a required security acceptance gate in onboarding before credentials are used, with operator confirmation token flow and policy metadata persistence.
- **Typed runtime config system**: Added `config.json` runtime configuration with schema-style normalization, safe defaults, validation, and first-run auto-generation (`config.example.json` as reference).
- **Runtime config hot reload**: Added file-watch based hot reload for runtime settings (including heartbeat/model/prompt-hook toggles) without full process restart for most knobs.
- **Security policy document**: Added `SECURITY.md` defining trust model boundaries, operator responsibilities, data handling expectations, and incident guidance.
- **Prompt hook pipeline**: Added formal prompt orchestration hooks (`bootstrap`, `memory`, `safety`) via `src/prompt-hooks.ts`.
- **MIT license**: Added a root `LICENSE` file with MIT license text.
- **HybridAI branding assets**: Added local HybridAI logo assets for landing page branding and navigation.

### Changed

- **Configuration model**: Shifted behavior/configuration defaults from env-only to typed `config.json`; `.env` now primarily carries secrets.
- **Prompt assembly architecture**: Replaced inline system-prompt composition in conversation/session-maintenance paths with the reusable hook pipeline.
- **Gateway heartbeat lifecycle**: Gateway now reacts to hot-reloaded config changes for heartbeat-relevant settings and restarts heartbeat accordingly.
- **Landing page positioning**: Refined site messaging toward enterprise value, security posture, digital coworker framing, and clearer USP comparison.
- **npm package scope**: Renamed the publish target from `hybridclaw` to `@hybridaione/hybridclaw` and set scoped publish access to public for npm organization publishing.

## [0.1.4](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.4)

### Added

- **Shared gateway protocol types**: Added `src/gateway-types.ts` to centralize gateway request/response types and command rendering helpers used by service/client layers.
- **Lint scripts**: Added `lint` scripts in both root and `container/` packages using strict TypeScript checks (`--noUnusedLocals --noUnusedParameters`).
- **HybridAI onboarding flow**: Added interactive `hybridclaw onboarding` and automatic startup onboarding when `HYBRIDAI_API_KEY` is missing, with browser-driven account creation/login guidance, API key validation, and `.env` persistence.
- **First-run env bootstrap**: Onboarding now auto-creates `.env` from `.env.example` when `.env` is missing.

### Changed

- **Gateway-only Discord runtime**: `gateway` now starts Discord integration automatically when `DISCORD_TOKEN` is set.
- **CLI simplification**: Removed standalone `serve` command; Discord is managed by `gateway`.
- **Gateway API contract simplification**: Removed compatibility aliases/fallbacks for command and chat payloads; APIs now use the current request schema only.
- **Onboarding endpoint configuration**: Onboarding now always uses fixed HybridAI paths under `HYBRIDAI_BASE_URL` (`/register`, `/verify_code`, `/admin_api_keys`) without separate endpoint env overrides.
- **Onboarding prompt UX polish**: Registration/login prompts are now single-line and non-indented, with clearer icon mapping by step (`⚙️` setup/meta, `👤` registration/account choice, `🔒` authentication, `🔑` API key input, `⌨️` bot selection, `🪼` bot list title).
- **Onboarding login flow cleanup**: Removed the redundant standalone API key page info line and kept the browser-driven auth/key retrieval flow focused on one prompt per action.

### Removed

- **Legacy workspace migration shim**: Removed old session-workspace migration path handling from IPC bootstrap code.
- **Unused health helper**: Removed unused `getUptime()` export from `src/health.ts`.

## [0.1.3](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.3)

### Added

- **Gateway-first runtime**: Added dedicated gateway entrypoint (`src/gateway.ts`) and shared gateway service layer (`src/gateway-service.ts`) to centralize chat handling, commands, persistence, scheduler, and heartbeat.
- **Gateway client module**: Added reusable HTTP client (`src/gateway-client.ts`) for thin adapters to call gateway APIs.
- **Web chat interface**: Added `/chat` UI (`site/chat.html`) with session history, new conversation flow, empty-state CTA, and in-chat thinking indicator.
- **Gateway HTTP API surface**: Added `/api/status`, `/api/history`, `/api/chat`, and `/api/command` endpoints with optional bearer auth and localhost-only fallback.

### Changed

- **Adapters simplified**: Discord (`serve`) and TUI now operate as thin gateway clients instead of hosting core runtime logic locally.
- **CLI and scripts**: Updated command descriptions and npm scripts so `gateway` is the primary runtime (`dev`/`start` now launch gateway).
- **Gateway HTTP server role**: `src/health.ts` now serves health, API routes, and static web assets.
- **Configuration and docs**: Added gateway-related env vars (`HEALTH_HOST`, `WEB_API_TOKEN`, `GATEWAY_BASE_URL`, `GATEWAY_API_TOKEN`) and updated `.env.example`/`README.md`.

### Fixed

- **TUI startup branding**: Restored the ASCII art startup logo in the TUI banner.

## [0.1.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.2)

### Added

- **Memory tool**: Added a new `memory` container tool with actions (`read`, `append`, `write`, `replace`, `remove`, `list`, `search`) for durable workspace memory files: `MEMORY.md`, `USER.md`, and `memory/YYYY-MM-DD.md`
- **Session search summaries**: Added a `session_search` tool that searches historical transcript archives and returns ranked per-session summaries with key matching snippets
- **Automatic transcript archiving**: Host now mirrors conversation turns into `<agent workspace>/.session-transcripts/*.jsonl` for long-term search and summarization
- **Session compaction module**: Added automatic conversation compaction with persisted session summaries and DB metadata (`session_summary`, `summary_updated_at`, `compaction_count`, `memory_flush_at`)
- **Pre-compaction memory flush**: Added a pre-compaction flush turn that runs with `memory`-only tool access to persist durable notes before old turns are summarized/pruned

### Changed

- **Prompt context assembly**: Discord, TUI, and heartbeat sessions now inject persisted `session_summary` context into the system prompt alongside bootstrap files and skills
- **Compaction execution model**: Discord and TUI now run compaction in the background after sending the assistant reply, preserving responsive UX
- **Configuration surface**: Added new `.env` knobs for compaction and pre-compaction flush thresholds/limits (`SESSION_COMPACTION_*`, `PRE_COMPACTION_MEMORY_FLUSH_*`)
- **Container runtime toolchain**: Agent container image now includes `python3`, `pip`, and `uv` in addition to existing `git`, `node`, and `npm` tooling

## [0.1.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.1)

### Added

- **Skills system**: `SKILL.md`-compatible discovery with multi-source loading (managed `~/.codex/skills`, `~/.claude/skills`, project `skills/`, agent workspace `skills/`) and precedence-based resolution
- **Skill invocation**: Explicit `/skill <name>`, `/skill:<name>`, and `/<name>` slash-command support with automatic SKILL.md body expansion
- **Skill syncing**: Non-workspace skills are mirrored into the agent workspace so the container can read them via `/workspace/...` paths
- **Read tool pagination**: `offset` and `limit` parameters for reading large files, with line/byte truncation limits (2000 lines / 50KB) and continuation hints
- **TUI `/skill` command**: Help text and pass-through for skill invocations in the terminal UI
- **Example skills**: `repo-orientation` and `current-time` skills in `skills/`
- **Tool progress events**: Live tool execution updates streamed to Discord and TUI via stderr parsing, with a typed `ToolProgressEvent` pipeline from container runner to UI layers

### Changed

- **Container iteration limit**: Increased `MAX_ITERATIONS` from 12 to 20
- **Skills prompt format**: Switched from inline skill content to compact XML metadata; model now reads SKILL.md on demand via `read` tool
- **TUI unknown slash commands**: Unrecognized `/` commands now fall through to the message processor instead of printing an error, enabling direct `/<skill-name>` invocation
- **Read tool**: Replaced simple `abbreviate()` output with structured truncation including byte-size awareness and user-friendly continuation messages
- **Path safety**: `safeJoin` now throws on workspace-escape attempts instead of silently resolving
- **Tool progress UX**: Progress behavior is now built-in (no env toggles), Discord uses `🦞 running ...`, and TUI shows one transient line per tool invocation that is cleared after completion so only the final `🦞 tools: ...` summary remains
- **TUI interrupt UX**: `ESC`, `/stop`, and `/abort` now interrupt the active run and return control to the prompt; abort propagates through the host/container pipeline and stops the active container request promptly

### Fixed

- **Skill invocation in history**: Last user message in conversation history is now expanded for skill invocations, ensuring replayed context includes skill instructions
