# Changelog

## [Unreleased]

### Added

### Changed

### Fixed

## [0.2.10](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.10)

### Added

- **Model retry policy helpers + tests**: Added shared model stream-fallback/retry predicates with dedicated unit coverage for retryable/non-retryable HybridAI error classes.
- **Message tool schema regression test**: Added explicit schema test coverage to enforce valid `components` parameter structure for the `message` tool definition.

### Changed

- **Stream failure fallback behavior**: Container model-call flow now applies stream-to-non-stream fallback policy through centralized retry helpers for consistent error classification.

### Fixed

- **HybridAI function schema rejection**: Fixed `message` tool `components` schema by defining `items` for the array variant, resolving `invalid_function_parameters` 400 failures.
- **HybridAI 500 handling robustness**: Streamed 5xx API failures now trigger the non-stream fallback path before hard-failing the turn.

## [0.2.9](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.9)

### Added

- **Release bundle guard scripts**: Added root and container `release:check` scripts that validate `npm pack --dry-run` contents and fail on forbidden files (tests, source, CI/config artifacts).
- **Dry-run publish helpers**: Added `publish:dry` scripts for root and container package smoke checks before publish.

### Changed

- **NPM package allowlists**: Added explicit `files` allowlists for root and container packages so publish output is limited to runtime assets and docs/templates/skills that HybridClaw loads at runtime.
- **Prepack gating**: Root and container packages now run clean build + release bundle validation during `prepack`.
- **CI packaging checks**: CI now runs root/container release bundle checks to catch publish-regression changes on PRs and pushes.
- **Silent reply token handling**: Centralized `__MESSAGE_SEND_HANDLED__` parsing/cleanup, added streaming prefix buffering for Discord/API output paths, and aligned prompt token constants with shared silent-reply utilities.
- **CLI build output mode**: Root `build` script now enforces executable mode on `dist/cli.js` after TypeScript compilation.

### Fixed

- **Silent token leakage in streams/history**: Streaming token fragments are now suppressed until divergence/confirmation, trailing silent tokens are stripped from mixed replies, and silent assistant placeholders are filtered from conversation history before model calls.

## [0.2.8](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.8)

### Added

- **Discord send policy controls**: Added runtime config for `discord.sendPolicy` (`open|allowlist|disabled`) with global/channel/guild/user/role allowlist checks for outbound sends.
- **Channel-aware prompt adapters**: Added channel-specific message-tool hint adapters (including Discord action/component guidance) injected into system prompts.
- **Expanded Discord message actions**: Added `react`, `quote-reply`, `edit`, `delete`, `pin`, `unpin`, `thread-create`, and `thread-reply` actions to the `message` tool path.
- **Message-tool regression coverage**: Added focused unit coverage for action aliases, target normalization, member/channel lookup behavior, send-policy checks, and channel hint injection.

### Changed

- **Message-tool intent guidance**: System prompt guidance now includes explicit send/post/DM/notify triggers, send parameter guidance (`to` + message), and reply suppression token handling for tool-only sends.
- **Action alias + target normalization**: Message action normalization now supports natural aliases (`dm`, `post`, `reply`, `respond`, `history`, `fetch`, `lookup`, `whois`) and normalizes Discord prefixes/mentions.
- **Tool description enrichment**: `message` tool descriptions now emphasize natural-language intent phrases and enumerate current/other configured Discord channels with supported actions.
- **Single-call DM targeting**: `send` now resolves user targets inline (IDs, mentions, usernames/display names with guild context), including fallback via `user`/`username` when no explicit channel target is passed.
- **Discord action API flexibility**: `/api/discord/action` now accepts normalized aliases and extended send payload fields (`components`, `contextChannelId`, threading/message mutation fields).

### Fixed

- **Structured target-resolution errors**: Member/user lookup failures now return structured JSON errors with disambiguation candidates and actionable hints.
- **Ambiguous target handling**: Added `resolveAmbiguous` support (`error|best`) to allow safe candidate return or best-match auto-resolution for member/user lookups.
- **Duplicate send-reply leakage**: Gateway chat responses now strip the message-send silent reply token and normalize final user-visible success text.

## [0.2.7](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.7)

### Added

- **Private approval slash command**: Added `/approve` with private (ephemeral) responses for `view`, `yes`, `session`, `agent`, and `no`, including optional `approval_id`.
- **Static model context-window catalog**: Added curated context-window mappings (Claude/Gemini/GPT-5 families) plus family-aware model-id fallback matching for session status metrics without runtime model-list fetches.
- **Discord command access + output controls**: Added runtime config support for `discord.commandMode`, `discord.commandAllowedUserIds`, `discord.textChunkLimit`, and `discord.maxLinesPerMessage`.
- **HybridAI completion budget control**: Added `hybridai.maxTokens` runtime setting and request wiring (`max_tokens`) for container model calls.

### Changed

- **Approval prompt visibility in Discord**: Channel responses now post a minimal “approval required” notice and move full approval details/decisions into private slash-command responses (`/approve`), matching the visibility pattern of `/status`.
- **Discord command handler context**: Command execution now receives invoking `userId` and `username` so approval actions can be scoped to the requesting user.
- **Discord slash command discoverability**: `/status` and `/approve` are now upserted globally for DM visibility while guild-only authorization checks remain enforced in servers.
- **Discord free-mode message relevance gating**: Free-mode replies now skip low-signal acknowledgements/URL-only chatter and avoid jumping in when other users are explicitly mentioned.
- **Status context usage reporting**: Session status now derives context usage from usage telemetry and static model context-window resolution instead of char-budget estimation only.
- **Approval parsing and trust scoping**: Approval response parsing now handles mention-prefixed/batched messages, and network trust scopes now normalize hosts to broader domain scopes.
- **Prompt dump diagnostics**: `data/last_prompt.jsonl` now includes media context plus allowed/blocked tool lists for richer debugging context.

### Fixed

- **Google Images/Lens upload compatibility**: `browser_upload` now supports CSS-selector targets and automatically falls back from wrapper refs to detected `input[type="file"]` selectors when upload fails with non-input elements.
- **Install-root container bootstrap**: CLI container readiness checks now resolve the package install root, preventing false build failures when invoked from non-package working directories.
- **DM slash command registration regression**: Restored reliable discovery/usage of HybridClaw slash commands in Discord DMs.

## [0.2.6](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.6)

### Added

- **Memory consolidation runtime controls**: Added `memory.decayRate` and `memory.consolidationIntervalHours` config support, plus gateway-managed periodic consolidation scheduling.
- **Scheduler job runtime metadata**: Added optional `scheduler.jobs[].name` / `description`, persisted `nextRunAt`, and scheduler status surfaces for runtime visibility.
- **Scheduler status API typing**: Added gateway status typing for scheduler jobs (`id`, `name`, `description`, `enabled`, `lastRun`, `lastStatus`, `nextRunAt`, `disabled`, `consecutiveErrors`).
- **CLI version flag**: Added top-level `hybridclaw --version` / `-v`.
- **Memory substrate architecture**: Added full SQLite-backed memory layers for structured KV (`kv_store`), semantic memory (`semantic_memories` with optional embeddings), knowledge graph (`entities` + `relations`), canonical cross-channel sessions, and usage events.
- **Knowledge graph model + APIs**: Added typed entity/relation enums (with custom value support), relation traversal query APIs, and normalized serialization/parsing for graph properties.
- **Canonical cross-channel sessions**: Added `canonical_sessions` persistence keyed by `(agent_id, user_id)` with rolling window retention, compaction summaries, and current-session exclusion support at recall time.
- **Usage aggregation layer**: Added `usage_events` persistence plus aggregation queries (daily/monthly totals, by-agent, by-model, and daily breakdown) and gateway `usage` command surface.
- **JSONL session export tools**: Added manual `export session [sessionId]` command and automatic compaction exports to `.session-exports/` for debugging and human review.
- **Memory service abstraction**: Added `MemoryService` + pluggable backend interface for session/memory access, semantic recall, knowledge graph APIs, canonical recall, and compaction helpers.
- **Memory consolidation engine**: Added consolidation engine + report model for periodic semantic decay operations.
- **Discord command namespace expansion**: Added `usage` and `export` command parsing support.
- **Coverage expansion**: Added comprehensive memory/DB unit tests (`tests/memory-service.test.ts`) and Discord parsing coverage for `usage`.

### Changed

- **Session compaction controls**: Added token-budget compaction knobs (`sessionCompaction.tokenBudget`, `sessionCompaction.budgetRatio`) and exposed them in config normalization + example config.
- **Gateway runtime scheduling**: Gateway now starts/restarts memory consolidation when runtime config changes and stops it cleanly on shutdown.
- **Heartbeat memory path**: Heartbeat turns now use `MemoryService` for session retrieval, prompt-memory context, and turn persistence.
- **Scheduler observability depth**: Scheduler now tracks and persists `nextRunAt`, includes job labels in logs, and keeps runtime state synchronized for status consumers.
- **Approval UX wording**: Red-tier approval prompt now instructs users to deny with `no` (alias `4`) instead of `skip`.
- **Prompt wording clarity**: Session summary hook text now explicitly frames memory as compressed/recalled durable context.
- **Runtime hygiene sweep**: Applied project-wide lint/import-order/format cleanup across gateway/runtime modules (audit, Discord channels, container runtime, onboarding, observability, skills/security, and Vitest configs) without behavior changes.
- **Schema migrations**: Replaced ad-hoc bootstrapping with versioned `user_version` migrations (including forward-version guard) and migration records.
- **Memory context injection**: Gateway prompt assembly now includes canonical cross-channel recall (summary + recent messages) while excluding the current session to avoid duplicate context.
- **SQLite migration baseline**: Introduced schema version `4` with explicit `user_version` migrations for canonical and usage tables.
- **SQLite concurrency defaults**: Database initialization now enforces `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000` for better concurrent read behavior.
- **Gateway memory integration**: Gateway flows now route session/history/memory operations through `MemoryService`, append canonical turns after successful responses, and record usage events from model telemetry.
- **Compaction instrumentation**: Session maintenance now exports compacted snapshots to JSONL and records richer compaction diagnostics.
- **Scheduled usage accounting**: Isolated scheduled task runs now record usage events for aggregation parity with interactive turns.

## [0.2.5](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.5)

### Added

- **Trusted-coworker approval flow**: Added green/yellow/red approval runtime with contextual red prompts and support for `yes`, `yes for session`, `yes for agent`, and `skip` (including `1/2/3/4` shorthand replies).
- **TUI approval selector**: Added an interactive TUI approval menu for pending red actions to reduce reply friction while preserving explicit consent.
- **Agent-scoped approval trust persistence**: Added durable per-agent trust state in `.hybridclaw/approval-trust.json` for `yes for agent` decisions.

### Changed

- **Approval policy location**: Moved policy configuration from `.claude/policy.yaml` to `.hybridclaw/policy.yaml` and updated workspace bootstrap seeding/docs accordingly.
- **Yellow-tier timing**: Increased yellow implicit approval countdown from 2s to 5s and simplified yellow narration text.
- **CI quality gates**: Updated CI to install container dependencies and enforce changed-file Biome checks plus root/container TypeScript lint before running unit tests.

### Fixed

- **Pinned red trust behavior**: Pinned-red actions now correctly reject session/agent trust promotion and fall back to one-time approval only.
- **Approval audit classification**: Approval audit events now mark `approved_agent` decisions as approved and include richer approval reason metadata.

## [0.2.4](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.4)

### Added

- **Dynamic Discord self-presence states**: Added health-aware presence management that maps runtime state to Discord status (`online`, `idle`, `dnd`) and applies maintenance `invisible` presence during shutdown.
- **Config-backed proactive scheduler jobs**: Added `scheduler.jobs[]` runtime jobs with `cron`/`every`/`at` schedules, `agent_turn`/`system_event` actions, and `channel`/`last-channel`/`webhook` delivery targets.
- **Scheduler metadata persistence for config jobs**: Added atomic persisted state at `data/scheduler-jobs-state.json` for per-job `lastRun`, `lastStatus`, `consecutiveErrors`, `disabled`, and one-shot completion tracking.
- **Discord humanization behaviors**: Added time-of-day/weekend pacing, conversation cooldown scaling after long back-and-forth, selective silence in active group channels, short-ack read-without-reply reactions, and reconnect startup staggering.

### Changed

- **Scheduler execution model**: Scheduler now co-schedules legacy DB tasks and config jobs in one timer loop with consistent due-time arming and persisted per-job error recovery behavior.
- **Discord inbound debounce behavior**: Debounce batching now skips immediate flush delays for commands/media and keeps per-channel debounce tuning for normal chat messages.
- **Documentation sync for Discord humanization/scheduler controls**: Updated README and site docs to cover health-driven presence, proactive job config, and human-like reply pacing behavior.

### Fixed

- **Uncanny Discord response timing**: Reduced robotic burst behavior by adding natural delay variation over long exchanges and reconnect bursts.
- **Over-eager group replies**: Free-mode channels now avoid unnecessary follow-up replies when another participant likely already answered.

## [0.2.3](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.3)

### Added

- **Discord channel policy config**: Added typed runtime config support for `discord.groupPolicy` (`open`/`allowlist`/`disabled`), `discord.freeResponseChannels`, and per-guild/per-channel mode overrides at `discord.guilds.<guildId>.channels.<channelId>.mode`.
- **Discord channel mode slash command**: Added `/channel-mode` with `off`, `mention`, and `free` options to set the active guild channel behavior directly from Discord.
- **Gateway channel control commands**: Added `channel mode` and `channel policy` command flows for inspecting/updating Discord channel response behavior via `!claw` commands.

### Changed

- **Discord trigger enforcement**: Guild message handling now applies channel mode + group policy before normal trigger checks, while still allowing prefixed commands in disabled channels.
- **Activation/status labeling**: Runtime status output now reflects `disabled`/`allowlist`/mixed free-channel activation modes instead of only legacy mention/all-messages labels.

### Fixed

## [0.2.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.2)

### Added

- **Discord image attachment ingest/cache**: Added receive-time image ingest with local cache under `data/discord-media-cache`, preserving attachment order and carrying `path`, `mimeType`, `sizeBytes`, and `originalUrl` per media item.
- **Structured media context pipeline**: Added typed media payload (`MediaPaths`/`MediaUrls`/`MediaTypes` equivalents) from Discord runtime through gateway/container request boundaries.
- **Attachment vision tools**: Added `vision_analyze` (and `image` alias) for Discord-uploaded image analysis using local cached paths first, with Discord CDN URL fallback.
- **Native multimodal injection**: Added direct image-part injection for vision-capable models, with automatic retry without image parts if the model rejects multimodal payloads.
- **Scoped Vitest test configs**: Added dedicated `vitest.{unit,integration,e2e,live}.config.ts` files and matching npm scripts (`test:unit`, `test:integration`, `test:e2e`, `test:live`, `test:watch`) for explicit suite boundaries.

### Changed

- **Discord channel module layout**: Completed migration of Discord runtime internals into `src/channels/discord/*`, including `runtime.ts` and `stream.ts`, and removed legacy root-level `src/discord.ts` shim.
- **Image-question tool routing**: Discord image questions now prioritize attachment vision (`vision_analyze`) and block `browser_vision` unless the user explicitly asks about the active browser tab/page.
- **Browser vision scope guidance**: Updated `browser_vision` tool description to clarify it is for browser-page tasks only, not Discord-uploaded files.
- **Test runner strategy**: Switched from compiled test artifacts (`dist-tests` + `tsconfig.tests.json`) to direct TypeScript execution via Vitest.
- **Test file location and conventions**: Moved basic test files from `src/*.test.ts` to `tests/` and aligned naming/scoping conventions for unit/integration/e2e/live suites.

### Fixed

- **Discord image analysis fallback behavior**: Added safer cache/CDN fallback handling and guardrails (Discord CDN allowlist, size/type limits, per-image success/failure logging) to avoid brittle image-analysis failures.
- **Regression coverage for wrong vision tool selection**: Added basic regression test coverage that Discord image questions should not route to browser screenshot vision.

## [0.2.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.1)

### Added

- **Discord `message` tool actions**: Added OpenClaw-style `message` tool support in the container with `read`, `member-info`, and `channel-info` actions, routed via the gateway API.
- **Gateway Discord action endpoint**: Added `POST /api/discord/action` to execute Discord context actions for tools and automated runs.

### Changed

- **Discord presence handling**: Switched from prompt-injected presence snapshots to cache-backed presence data returned by `member-info` (`status` + `activities`) when available.
- **Discord context guidance**: Updated safety prompt policy to explicitly route recap/member lookup questions through `message` tool actions instead of guessing.
- **Tool allowlists**: Enabled `message` in heartbeat and base subagent allowed tool sets for delegated and automated workflows.
- **Container gateway auth context**: Container input now carries gateway base URL/token and maps loopback hosts to `host.docker.internal` for in-container API reachability.
- **Gateway token fallback**: Runtime now generates an internal gateway API token when no explicit token is configured, while preserving env/config overrides.

### Fixed


## [0.2.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.0)

### Added

- **Personality switcher skill**: Added `skills/personality/SKILL.md` with `/personality` command workflow (`list`, `set`, `reset`) and a 25-profile persona set (including expert, style, and role personas like `pirate`, `noir`, `german`, `coach`, `doctor`, `soldier`, and `lawyer`).
- **Ralph loop runtime mode**: Added configurable autonomous iteration (`proactive.ralph.maxIterations`) in the container tool loop. When enabled, turns continue automatically until the model emits `<choice>STOP</choice>` (or the configured loop budget is reached).
- **Ralph command controls**: Added gateway/TUI command support for `ralph on|off|set <n>|info`, with immediate current-session container restart to apply loop settings without waiting for idle recycle.
- **Skill creator authoring toolkit**: Added bundled `skills/skill-creator/` (invocable skill, references, and helper scripts) for initializing, validating, packaging, and generating `agents/openai.yaml` metadata for new skills.
- **Discord context enrichment pipeline**: Added pending guild-history context, participant alias memory, `@name` mention-to-ID rewrite support, and optional per-channel presence snapshots for better grounded Discord replies.

### Changed

- **Personality persistence contract**: Standardized the managed `SOUL.md` personality block to `Name`, `Definition`, and `Rules`, so active persona behavior is fully file-driven.
- **Personality style policy**: Updated persona rules so style signals are explicitly visible for the active personality (instead of only a subset).
- **Personality skill prompt mode**: Set personality switching to command-only behavior (`always: false`, `disable-model-invocation: true`) to avoid per-turn prompt overhead while keeping `/personality` invocations available.
- **Workspace AGENTS template behavior**: Updated `templates/AGENTS.md` group-chat guidance with explicit "Quality > quantity" speaking rules and emoji-reaction social-signal policy (`React Like a Human`, one reaction per message).
- **Runtime self-awareness hook**: Prompt assembly now always injects runtime metadata (`version`, UTC date, model/default model, chatbot/channel/guild IDs, node/OS/host/workspace) and keeps it active in `minimal` mode.
- **Discord runtime controls**: Added and hot-wired `discord.{guildMembersIntent,presenceIntent,respondToAllMessages,commandsOnly,commandUserId}` config behavior for intent selection, trigger policy, and command-user authorization.
- **Gateway status reporting**: `status` command output now includes the running HybridClaw version line.

### Fixed

## [0.1.24](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.24)

### Added

- **Discord edit-in-place streaming pipeline**: Added end-to-end assistant text delta streaming from container runtime to Discord delivery, including NDJSON `text` events and incremental Discord message edits.
- **Discord stream/chunk primitives**: Added `src/discord-stream.ts` (stream lifecycle manager with throttled edits and rollover) and `src/chunk.ts` (boundary-aware chunking with code-fence preservation and line limits).
- **Discord conversational event handling**: Added message debounce batching, in-flight run tracking, message edit/delete interruption handling, and thumbs-down reaction feedback capture for subsequent context.

### Changed

- **Discord reply delivery semantics**: Replaced fixed 2000-char truncation with complete multi-message delivery and chunk-safe send/edit behavior.
- **Discord responsiveness model**: Message handling now keeps typing indicators alive during long turns, updates presence while processing, and acknowledges queued work with processing reactions.
- **Discord context assembly**: Conversation turns now prepend reply-chain/thread context and include parsed attachment context (inline text/code where readable, metadata fallback for unsupported types).

### Fixed

- **Long response truncation**: Removed `.slice(0, 2000)` response truncation paths that dropped tail content and broke code blocks.
- **Perceived Discord stalls**: Fixed single-shot typing behavior by introducing a periodic typing loop for long-running turns.
- **Mid-turn user correction handling**: Edited/deleted source messages now cancel in-flight processing and clean up partial streamed output to prevent orphaned replies.
- **Screenshot reply verbosity in Discord**: Image-attachment responses now suppress workspace-path narration and default to concise delivery text (`Here it is.`/`Here they are.`).

## [0.1.23](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.23)

### Added

- **Token usage observability fields**: `model.usage` audit events now include prompt/completion/total token counts (API-reported when available, deterministic estimates as fallback), model-call counts, and char-level prompt/completion sizing.
- **Context optimization telemetry**: Added `context.optimization` audit events with history compression statistics (per-message truncation count, dropped chars/messages, and applied history budgets).

### Changed

- **Runtime-config migration logging clarity**: Startup schema normalization now logs a dedicated `normalized config schema vN` message when version is unchanged, instead of reporting a misleading `migrated ... from vN to vN`.
- **History prompt assembly**: Conversation history now applies per-message truncation plus head/tail-aware budget compression to reduce token load while preserving recent context.
- **Bootstrap file truncation strategy**: Oversized workspace context files now use head/tail truncation (70/20 split) instead of head-only clipping.
- **Prompt mode tiers**: Prompt hooks now support `full`/`minimal`/`none` modes; pre-compaction memory flush uses `minimal` mode to reduce static prompt overhead.

### Fixed

- **Local runtime-state git noise**: Added `.hybridclaw/` to `.gitignore` so container image fingerprint state files are no longer reported as untracked changes.

## [0.1.22](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.22)

### Added

- **Skills trust scanner**: Added `src/skills-guard.ts` with Hermes-derived regex threat detection (exfiltration, prompt injection, destructive ops, persistence, reverse shells, obfuscation, supply chain, credential exposure), structural checks (file count/size limits, binary blocking, symlink escape checks), and invisible-unicode detection.
- **Skill scan cache**: Added mtime-signature + content-hash scanner caching to skip re-scan on unchanged skills.
- **Extended SKILL frontmatter**: Added support for `always`, `requires.bins`, `requires.env`, and `metadata.hybridclaw.{tags,related_skills}` while preserving backward compatibility for existing fields.

### Changed

- **Skill discovery tiers**: Expanded skill discovery precedence to `extra < bundled < codex < claude < agents-personal < agents-project < workspace`, including `config.skills.extraDirs[]` and `.agents/skills` interop paths.
- **Skill prompt embedding modes**: Implemented Always/Summary/Hidden behavior via frontmatter flags (`always`, `disable-model-invocation`) with `maxAlwaysChars=10000`, `maxSkillsPromptChars=30000`, and `maxSkillsInPrompt=150`.
- **Skill eligibility gating**: Skills with unmet `requires` are now silently excluded from both prompt availability and slash-command resolution.
- **Skill slash commands**: Added command-name sanitization (32-char max), reserved built-in command blocking, and deterministic collision deduplication (`-2`, `-3`, ...), while keeping `/skill name`, `/skill:name`, and `/<name>` invocation compatibility.
- **Web tool routing guidance**: Tool descriptions and runtime prompt guidance now include explicit `web_fetch` vs browser decision rules, concrete SPA/auth/app categories, and quantified cost asymmetry.
- **web_fetch escalation signaling**: `web_fetch` now emits structured escalation hints (`javascript_required`, `spa_shell_only`, `empty_extraction`, `boilerplate_only`, `bot_blocked`) and surfaces them in tool output for browser fallback routing.
- **Browser extraction steering**: `browser_navigate` responses now include text preview metadata and explicit next-step hints (`browser_snapshot` with `mode="full"`), and docs/prompts now clarify that `browser_pdf` is export-only (not text extraction).

### Fixed

## [0.1.21](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.21)

### Added

- **Browser tool expansion**: Added `browser_vision`, `browser_get_images`, `browser_console`, and `browser_network` to the container browser toolset and subagent allowlists.
- **Frame-aware browser interactions**: Added optional `frame` targeting to browser interaction tools and exposed iframe metadata in browser snapshots.
- **Discord artifact delivery path**: Added proactive/delegation artifact propagation so generated screenshot/PDF outputs can be attached to Discord messages.

### Changed

- **Vision request payload policy**: Browser vision requests now always send a single-message payload with `enable_rag: false` and include required active request context (`baseUrl`, `apiKey`, `model`, `chatbot_id`).
- **Browser snapshot modes**: Added explicit snapshot `mode` support (`default`, `interactive`, `full`) for tighter interactive-only dumps.

### Fixed

- **Delegation attachment gap**: Resolved delegated/scheduled tool-result path that previously posted text-only proactive responses while omitting generated artifacts.
- **Bot-detection signaling**: Browser navigation responses now emit structured warning hints when known anti-bot/verification titles are detected.

## [0.1.20](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.20)

### Added

- **Browser auth policy clarification**: Added explicit runtime guidance that user-directed login/auth-flow testing is allowed with browser tools on the requested domain.

### Changed

- **Persistent browser login continuity**: Browser tooling now persists per-session profile/state by default (`AGENT_BROWSER_PROFILE` + `AGENT_BROWSER_SESSION_NAME`) with configurable overrides (`BROWSER_PERSIST_PROFILE`, `BROWSER_PERSIST_SESSION_STATE`, `BROWSER_PROFILE_ROOT`, `BROWSER_CDP_URL`).
- **Safety prompt alignment**: System safety hook now explicitly rejects fabricated “public-only/unauthenticated browser” limitations and prioritizes real tool/policy outcomes.
- **Documentation refresh**: Updated README and website docs (`docs/index.html`) with authenticated browser-flow support and browser session persistence behavior.

### Fixed

- **Audit secret leakage risk**: Structured audit tool-call arguments now redact sensitive fields (password/token/secret/etc.), including `browser_type.text`, to avoid credential plaintext in audit trails.

## [0.1.19](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.19)

### Added

- **Observability ingest exporter**: Added structured audit export to HybridAI via `POST /api/v1/agent-observability/events:batch` with cursor-based delivery, payload/event caps, and local runtime diagnostics in `GET /api/status`.
- **Observability token cache store**: Added persistent SQLite token cache (`observability_ingest_tokens`) for bot-scoped ingest tokens used by observability push.
- **Gateway admin shutdown endpoint**: Added `POST /api/admin/shutdown` for graceful local gateway termination and restart workflows.

### Changed

- **Token lifecycle flow**: Observability ingest token management now uses `POST /api/v1/agent-observability/ingest-token:ensure` (no legacy token-route compatibility paths).
- **Gateway lifecycle handling**: `hybridclaw gateway restart` and stop/restart behavior now handle managed and unmanaged gateway ownership paths more reliably.
- **Documentation refresh**: Updated README and website docs (`docs/index.html`) with observability push/token behavior, restart guidance, and operational visibility messaging.

### Fixed

- **Observability auth recovery**: Ingest auth failures now trigger token refresh attempts against the v1 ensure endpoint before pausing export.
- **Gateway status diagnostics**: Status responses now include richer observability state and PID-aware runtime diagnostics for easier troubleshooting.

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
