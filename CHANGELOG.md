# Changelog

## [Coming up]
### Added

- **MemPalace memory plugin**: Added the bundled `mempalace-memory` plugin so
  local HybridClaw installs can layer MemPalace recall on top of native memory,
  expose `/mempalace ...` for manual CLI access, and auto-save turns back into
  MemPalace through hook-driven transcript mining and native-memory mirroring.
- **Plugin dependency install and health checks**: Plugin manifests can now
  declare pip, npm, and external runtime dependencies, `plugin install` /
  `plugin reinstall` can provision declared dependencies with explicit
  approval, and `plugin check` reports package, binary, env, and config health
  for local plugins.

### Changed

- **Threaded email replies across built-in and Brevo delivery**: Outbound email
  sends now accept explicit `In-Reply-To` and `References` headers through the
  `message` tool/API and the repo-shipped `brevo-email` plugin, keeping
  follow-up replies inside the existing mail thread.
- **Admin console tools and gateway UX**: The `/admin/tools` catalog now only
  shows live built-in and enabled plugin tools, all admin tables support
  click-to-sort headers, the Tools view now labels usage as `Invocations`,
  and the Gateway page adds a managed restart action with clearer restart
  state handling.
- **Email credential wiring**: Email setup and runtime config now support
  `email.password` as a SecretRef-backed field so stored `EMAIL_PASSWORD`
  secrets can stay referenced from config without falling back to plaintext
  values.
- **Plugin install ergonomics**: Local plugin installs now accept bare plugin
  ids from the repo `plugins/` directory, prefer plugin-local executables after
  dependency setup, and reuse the normal local approval flow when dependency
  installers need permission to modify the plugin environment.
- **Discord concierge approvals**: Discord concierge prompts now render
  native urgency buttons, resume the pending request from button clicks,
  disable the prompt buttons after selection, and keep normal progress
  reactions visible while the resumed run executes.
- **MemPalace recall routing**: The bundled MemPalace plugin keeps HybridClaw's
  built-in memory active, falls back to CLI `wake-up` / `search` recall when no
  MemPalace MCP server is enabled, and automatically switches prompt-time
  recall over to a configured `mempalace` MCP server when one is available.

### Fixed

- **Timed reminder prompt timestamps**: Absolute `cron` reminder guidance now
  tells the model to emit offset-bearing one-shot timestamps that mirror the
  user's timezone instead of defaulting to UTC-style `Z` timestamps in the
  prompt examples.
- **Built-in email config reloads**: Gateway config changes to built-in email
  transport settings now restart the email integration automatically so SMTP /
  IMAP updates apply without a full gateway restart.
- **Provider `maxTokens` policy**: Provider-facing model requests now omit
  `maxTokens` for non-Anthropic models and always send a discovered Anthropic
  limit, falling back to `32000` when discovery metadata is unavailable.
- **Plugin dependency safety**: Manifest-provided external dependency checks no
  longer execute through a shell, and already-installed plugins now recompute
  their dependency plan from the installed directory before reinstalling
  runtime packages.

## [0.12.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.1)

### Added

- **Admin console channel operations**: Added an `/admin` Channels workspace
  with a transport catalog, browser-based editors for Discord, WhatsApp, email,
  Microsoft Teams, and iMessage, managed secret fields for channel
  credentials, and live WhatsApp pairing QR display.
- **Remote-access runbook**: Added maintainer docs for reaching `/chat`,
  `/agents`, `/admin`, and remote CLI/TUI clients through SSH tunnels or
  host-managed Tailscale while keeping the gateway bound to loopback.

### Changed

- **Explicit email thread headers**: The `message` tool/API and the
  repo-shipped `brevo-email` plugin now accept explicit `inReplyTo` and
  `references` Message-ID headers so outbound replies can attach to an existing
  external thread when needed.
- **Secret-backed email transport config**: Email setup and runtime config now
  support `email.password` as a SecretRef-backed field, and
  `hybridclaw channels email setup` keeps stored `EMAIL_PASSWORD` secrets
  referenced from config instead of falling back to plaintext.
- **Local slash-command help**: TUI and embedded web `/help` output now comes
  from the shared command registry, keeping command listings surface-aware,
  alphabetized, and aligned with slash-menu suggestions.

### Fixed

- **TUI sandbox preflight**: `hybridclaw tui` now follows the sandbox mode
  reported by a reachable gateway, avoiding unnecessary container rebuild
  checks when the running gateway is already in host mode and vice versa.
- **Secret-handling UX**: Hidden secret prompts now restore terminal state
  correctly after earlier readline prompts, and `auth status` surfaces report
  sensitive credentials as `configured` instead of printing partial tokens or
  keys.

## [0.12.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.0)

### Added

- **Managed local eval benchmark workflows**: Added top-level `hybridclaw eval` plus
  local `/eval` support, loopback OpenAI-compatible eval environment helpers,
  detached benchmark command launching, managed `tau2` lifecycle flows, and a
  native `terminal-bench-2.0` runner with progress updates and run logs.
- **Dream memory consolidation controls**: Added local `dream on|off|now`
  commands with nightly scheduling, startup catch-up after downtime, and
  on-demand workspace memory consolidation summaries.
- **Admin skill authoring surfaces**: Added admin-console and HTTP support for
  creating local skills from a form or uploading ZIP archives, with scanner
  checks and staged publish flow before writing into project `skills/`.
- **Brevo email plugin channel**: Added the repo-shipped `brevo-email` plugin
  for per-agent email addresses, inbound webhook parsing, outbound SMTP relay,
  address management commands, and configurable `fromName` /
  `fromAddress` overrides.
- **Knowledge-management skills**: Added bundled `llm-wiki` and
  `zettelkasten` skills for persistent wiki maintenance, linked-note capture,
  and long-lived research workflows.
- **OpenAI compatible API**: Added an OpenAI compatible API to the gateway.

### Changed

- **Skill catalog and operator UX**: Added normalized category metadata across
  bundled and community skills, grouped `skill list` output, richer TUI/admin
  skills views, and refreshed bundled-skill guidance around knowledge and
  install-helper workflows.
- **Scheduler and console review flow**: Improved the admin scheduler board so
  one-shot jobs surface full outputs and review state more reliably, while the
  embedded console handles compact mobile navigation more cleanly.

## [0.11.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.11.0)

### Added

- **OpenAI-compatible gateway API**: Added loopback-scoped `/v1/models` and
  `/v1/chat/completions` endpoints so local tools can talk to HybridClaw
  through an OpenAI-compatible surface with streaming responses and usage
  reporting.
- **Workspace approval allowlist controls**: Added a workspace-scoped approval
  allowlist plus `/approve always` handling so operators can persist trusted
  approvals more deliberately across chat, TUI, and gateway flows.
- **Dark-mode console and richer web controls**: Added console dark mode, a
  reusable dropdown component, extracted icon set, and slash-command
  suggestions in the web chat UI for faster local operator workflows.
- **Channel setup how-to documentation**: Added step-by-step channel setup
  guides for Discord, email, WhatsApp, iMessage, and Microsoft Teams in the
  maintainer docs.
- **Release publishing automation**: Added npm publish-on-release automation
  and switched trusted publishing over to npm OIDC for release workflows.

### Changed

- **Gateway lifecycle behavior**: Improved gateway start, restart, and
  container replacement flow so runtime refreshes are cleaner, container swap
  logging is less noisy, and packaged installs prefer public runtime image
  pulls.
- **Approval and web chat UX**: Tightened approval wording, aliases, and
  replay handling while improving mobile chat layout, approval interactions,
  ordered-list rendering, and keyboard accessibility in the web surfaces.
- **ClawHub and operator docs surfaces**: Added `CLAWHUB_API_BASE_URL`
  overrides for skill imports, refreshed docs and setup guidance, and aligned
  console dark-theme styling with the public documentation shell.

### Fixed

- **Gateway startup and update guidance**: Fixed startup diagnostics, provider
  auth/model guidance, and post-update restart reminders so operators get more
  accurate local recovery steps.
- **Browser and host runtime cleanup**: Fixed browser daemon shutdown handling
  and host-browser runtime availability so cleanup failures are treated as
  best-effort instead of breaking the session.
- **Runtime config and health edge cases**: Fixed config revision
  synchronization, gateway health payload regressions, favicon fallbacks, and
  skill import retries under HTTP 429/503 responses.

## [0.10.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.10.0)

### Added

- **OpenClaw and Hermes Agent migration commands**: Added
  `hybridclaw migrate openclaw` and `hybridclaw migrate hermes` to import
  compatible workspace files, agent/home config, model settings, and optional
  secrets into a target HybridClaw agent with `--dry-run`, `--overwrite`,
  `--agent`, and per-run migration reports under `~/.hybridclaw/migration/`.
- **Encrypted runtime secret store**: Runtime credentials in
  `~/.hybridclaw/credentials.json` now use per-secret AES-256-GCM encryption
  with owner-only permissions, separate master-key sourcing via
  `HYBRIDCLAW_MASTER_KEY`, `/run/secrets/hybridclaw_master_key`, or a local
  owner-only `credentials.master.key`, and automatic migration from legacy
  plaintext secret files.
- **SecretRefs and named secrets**: Selected runtime config fields can now
  resolve secret-bearing values from `env` or encrypted `store` references,
  local TUI and web sessions expose `/secret list|set|unset|show|route ...`,
  and generic named secrets can be stored without adding new top-level env
  variables.
- **Secret-backed HTTP requests**: Added the `http_request` tool plus
  gateway-side auth injection for direct API calls. Requests can use
  `bearerSecretName`, `secretHeaders`, strict `<secret:NAME>` placeholders, or
  URL-based auth rules so models can call authenticated APIs without seeing the
  plaintext credential.
- **`llama.cpp` local backend**: Added `llamacpp` as a first-class local
  provider across `auth login local`, provider discovery, reachability checks,
  model selection surfaces, doctor output, and container/runtime routing.

### Changed

- **Local-provider onboarding flow**: `hybridclaw auth login local` now accepts
  an optional model id so operators can enable LM Studio, llama.cpp, Ollama,
  or vLLM first and choose a model later, and interactive onboarding can skip
  remote-provider auth entirely when the planned setup is local-only.
- **Secret access model**: Runtime secret reads now prefer explicit environment
  overrides and otherwise resolve secrets from the encrypted store on demand
  instead of broadly mirroring decrypted values into ambient `process.env` at
  startup.
- **Secret persistence boundaries**: Reserved non-secret runtime config names
  such as `CONTAINER_IMAGE`, `CONTAINER_MEMORY`, `DISCORD_PREFIX`, `DB_PATH`,
  and related operational settings are now excluded from encrypted secret
  migration and rejected by the local `/secret` command surface.
- **Security documentation and comparison copy**: Updated the README, public
  docs, comparison tables, and runtime/internal docs to reflect encrypted
  secret storage, master-key separation, SecretRef-backed API auth injection,
  trust-first onboarding, and current runtime security principles.

### Fixed

- **Startup onboarding loops**: Gateway and TUI startup no longer keep
  re-triggering onboarding once trust acceptance, local-provider setup, or
  existing credentials already satisfy the runtime prerequisites.
- **TUI model guidance for local backends**: Model-selection prompts now give
  clearer next steps when a local backend is enabled without a selected model,
  reducing dead-end startup guidance around local-only setups.

## [0.9.8](https://github.com/HybridAIOne/hybridclaw/tree/v0.9.8)

### Added

- **Concierge routing controls**: Added a configurable concierge router that can
  ask users about urgency before long-running work, plus `concierge info|on|off`,
  `concierge model [name]`, and `concierge profile <asap|balanced|no_hurry> [model]`
  across gateway, TUI, and slash-command surfaces.
- **Tracked runtime config revisions**: Added automatic revision snapshots for
  `~/.hybridclaw/config.json`, persisted in `~/.hybridclaw/data/config-revisions.db`,
  with `hybridclaw config revisions [list|rollback|delete|clear]` so operators can
  audit and restore configuration changes.
- **Expanded agent install flows**: Added `agent install` support inside running
  gateway/TUI sessions, direct `.claw` URL installs, `--skip-import-errors`,
  and tighter handling for official and GitHub package sources.
- **Plugin inbound webhooks**: Added plugin-owned inbound webhook routes plus
  `registerInboundWebhook(...)`, `dispatchInboundMessage(...)`, and HTTP helper
  utilities in the plugin SDK so plugins can receive external events and route
  them through the normal assistant turn pipeline.
- **Sokosumi bundled skill**: Added the first-party `sokosumi` skill for
  API-key-authenticated agent hires, coworker task creation, job monitoring,
  and result retrieval.

### Changed

- **HybridAI default-model baseline**: Updated the shipped `hybridai`
  provider default from `gpt-5-nano` to `gpt-4.1-mini`, reordered the
  built-in HybridAI model list so onboarding and fresh configs pick that model
  first, and added static capability metadata for `gpt-4.1-mini` without
  changing other provider defaults or concierge profile mappings.
- **CI, smoke tests, and release checks**: Expanded integration and e2e
  coverage for gateway docs, database/session flows, config reloads, skill
  resolution, chat APIs, npm installs, Docker runtime checks, and agent
  container flows, while tightening release-check and Docker preflight
  coverage in CI.
- **Plugin service boundaries**: Extracted gateway plugin service plumbing into
  clearer modules, tightened plugin service boundaries, and improved mock/test
  coverage around plugin reload and webhook dispatch behavior.
- **Public docs and branding surfaces**: Refreshed the public docs shell with
  the HybridClaw logo asset, updated favicon and fallback assets, simplified
  navigation chrome, trimmed hidden internal docs, and refreshed release-facing
  docs so the landing page, README, and manual reflect the shipped feature set.
- **Package and manifest handling**: Enabled exact npm saves for repo manifests
  and pinned package manifests to their locked versions so release artifacts
  stay aligned with the checked-in lockfiles.

### Fixed

- **Gateway image docs coverage**: Fixed packaged gateway images so the repo
  docs ship into runtime images instead of being dropped by `.dockerignore`.
- **Docs deep-link fallback**: Fixed static docs hosting so deep links under the
  docs shell route through the fallback page instead of breaking on refresh.
- **Container setup reliability**: Fixed packaged installs so pull-only
  container setup stays on the published runtime image path, and hardened agent
  image apt cache locking during builds.
- **Agent install and plugin webhook edge cases**: Fixed agent install stream
  typing, import cleanup, partial-failure reporting, and gateway resolution
  errors, and tightened plugin webhook validation, error handling, and
  dispatch.
- **Config revision robustness**: Fixed inferred revision route sanitization,
  duplicate config reads during revision sync, summary loading behavior, and
  watcher timer cleanup for tracked runtime config changes.

## [0.9.7](https://github.com/HybridAIOne/hybridclaw/tree/v0.9.7)

### Added

- **Mistral provider support**: Added
  `hybridclaw auth login|status|logout mistral`, support for
  `mistral/...` model ids in selection commands, runtime credential handling
  for Mistral requests, discovered model catalog entries with canonical-name,
  context-window, and vision metadata, and recommended-model coverage in
  selectors and status output.
- **ATIF-compatible trace export**: Added `export trace [sessionId|all|--all]`
  across gateway, TUI, and chat command surfaces so operators can export
  structured debug trace JSONL with tool calls, token usage, git context,
  attribution metadata, and compatibility fields for downstream trace tooling.
- **HybridClaw docs and help retrieval**: Added a searchable `/docs` browser
  docs shell, raw-markdown `/docs/agents.md`, the bundled
  `hybridclaw-help` skill, and prompt-hook routing that fetches public docs
  before answering HybridClaw product questions.
- **Obsidian bundled skill**: Added a first-party `obsidian` skill plus agent
  metadata for vault-aware note search, creation, moves, and link-preserving
  edits.

### Changed

- **Web chat streaming and replay UX**: Simplified stream frame state and
  replay reuse, added NDJSON fallback handling plus decoder-tail flushing,
  batched DOM updates, and preserved scroll position during streaming so the
  built-in web chat behaves more smoothly under live output.
- **Session previews and export UX**: Shared conversation-preview helpers
  across sessions and agent cards, added clearer timestamp/snippet output in
  `/sessions`, and exposed the new `export session` and `export trace`
  subcommands consistently in help text and slash menus.
- **Docker images and publish pipeline**: Reworked the gateway and agent
  Dockerfiles into clearer multi-stage builds, added the agent `runtime-lite`
  target plus `HYBRIDCLAW_CONTAINER_TARGET`, and added CI Docker preflight
  builds plus explicit runtime targets in publish workflows.
- **Public docs routing and landing pages**: Moved the browsable docs shell to
  `/docs`, kept the legacy `/development` entry as a redirect, refreshed the
  static docs assets, and added a HybridClaw Cloud callout across the public
  landing page.

### Fixed

- **Local iMessage self-chat fallback**: Skipped attributed-body-only
  self-chat rows that look like replayed history or control commands so local
  iMessage polling no longer injects stale self-chat content.
- **Trace export and secret redaction hardening**: Expanded redaction coverage
  for GitHub/npm tokens, emails, IPs, phone numbers, SSNs, credit cards, and
  high-entropy strings, anonymized runner-home paths in trace exports, and
  restored paused TTY state after hidden secret prompts.
- **Mistral discovery and container build polish**: Tightened canonical and
  deprecated Mistral model handling plus availability checks, and fixed
  container/gateway Docker builds around native addons, dependency pruning,
  runtime targets, and npm prune failure modes.

## [0.9.6](https://github.com/HybridAIOne/hybridclaw/tree/v0.9.6)

### Changed

- **Release and docs alignment**: Refreshed the public README install section
  with direct changelog and docs links, updated the static docs landing page so
  its release highlights match the current shipped feature set, and aligned the
  maintainer release guide with the changelog's `Coming up` workflow and the
  docs surfaces that should be refreshed before a release.

## [0.9.5](https://github.com/HybridAIOne/hybridclaw/tree/v0.9.5)

### Added

- **Dual-backend iMessage channel**: Added `hybridclaw channels imessage setup`
  plus gateway runtime support for local macOS delivery through `imsg` +
  Messages `chat.db` and remote relay delivery through BlueBubbles webhooks
  and REST sends.
- **Admin terminal page**: Added a browser-based `Terminal` page inside the
  embedded admin console so operators can open a live PTY session from
  `/admin/terminal` alongside the existing gateway and session views.
- **Local runtime config commands**: Added `hybridclaw config`,
  `hybridclaw config check`, `hybridclaw config reload`, and
  `hybridclaw config set <key> <value>`, plus matching local `/config`
  slash commands for TUI and web sessions. The config view now shows the
  active config file path, `set` validates immediately after saving, and
  `reload` performs an in-process hot reload from disk.
- **HybridAI observability ingest**: Added runtime `observability.*` config
  plus background forwarding of structured audit events such as `bot.set` to
  the HybridAI observability ingest API with cached ingest tokens and restart
  handling.

### Changed

- **Built-in browser tool warnings**: Grouped the `browser_*` subtools into
  one browser toolset in doctor/config diagnostics so unused-tool suggestions
  are clearer before operators disable them.
- **Packaged install bootstrap and XLSX tooling**: Published installs now
  bootstrap the packaged container runtime dependencies automatically, and the
  bundled XLSX workflow now uses `xlsx-populate` instead of `exceljs` to avoid
  a large deprecated transitive dependency chain.
- **Host-mode filesystem allowlist**: Host-mode agent access now uses an
  explicit allowlist rooted at the user home directory, the gateway working
  directory, `/tmp`, and configured bind or additional-mount host paths,
  rather than an implicit project-root escape hatch.
- **Default HybridAI output budget**: Restored the default
  `hybridai.maxTokens` value to `4096` while keeping it configurable through
  the runtime config file and the new `config set` command surface.
- **Browser login profile handling**: Tightened the headed Chromium login flow
  around the dedicated automation profile, including clearer automation-only
  password-store intent and deferred Playwright cache directory creation.

### Fixed

- **Admin terminal and iMessage hardening**: Tightened admin terminal session
  transport and authentication, cleaned up stale browser sessions around
  terminal/browser flows, stabilized iMessage self-chat handling, and restored
  the local iMessage attributed-body fallback path.
- **Fresh-install runtime startup failures**: Fixed packaged fresh installs so
  host/container workers no longer miss nested runtime dependencies, surfaced
  worker startup crashes immediately in TUI instead of hanging on the spinner,
  and added clearer runtime error text when the worker exits before producing
  output.
- **Docker doctor guidance for sandboxed installs**: `hybridclaw doctor` now
  treats Docker as a required dependency whenever the resolved sandbox mode is
  not `host`, with explicit guidance to switch to host mode when Docker is not
  available.
- **HybridAI recovery and auth-status handling**: Improved empty-completion and
  retry-path diagnostics, cached parsed provider error bodies, simplified
  debug serialization, removed unused parsed fields, and tightened
  `auth status hybridai` output so it reports local auth/config state without
  exposing the credentials file path.
- **Local slash-command consistency**: Added `/config` to the startup slash list, and aligned
  `config check` so it validates only the runtime config file instead of
  surfacing broader doctor hygiene warnings.
- **Plugin recovery workflows**: Tightened plugin enable/disable, config, and
  reload rollback flows so disabling a broken or missing plugin no longer
  requires discovery, no-op CLI output no longer claims the config changed,
  and secondary plugin reload failures are surfaced more clearly.

## [0.9.4](https://github.com/HybridAIOne/hybridclaw/tree/v0.9.4)

### Added

- **Packaged agent GitHub install sources and activation**:
  `hybridclaw agent install` now accepts
  `official:<agent-dir>` and `github:owner/repo[/<ref>]/<agent-dir>` sources,
  and `hybridclaw agent activate <agent-id>` can set the default agent for new
  requests.
- **Agent presentation profiles with image assets**: Agent configs and `.claw`
  manifests can now declare `displayName` and workspace-relative `imageAsset`
  metadata so web chat can show the active agent name and profile image.
- **Startup opening automation for fresh sessions**: Gateway/web startup can
  proactively run `BOOTSTRAP.md` for one-time onboarding and `OPENING.md` for a
  fresh-session opening message before the user types the first turn.

### Changed

- **Bootstrap templates and workspace completion detection**: Refreshed the
  shipped onboarding template around a lighter first-hatch flow, added the
  optional `OPENING.md` template, and tightened workspace completion checks so
  onboarding stays active until there is real post-bootstrap evidence.
- **Web chat default-agent routing and history context**: New web sessions now
  follow the configured default agent, preserve agent presentation across
  history reloads, and keep bootstrap placeholder state visible while startup
  autostart is still running.

### Fixed

- **HybridAI chatbot fallback resolution**: Gateway chat, scheduler runs, and
  bootstrap autostart can fall back to `HybridAI /api/v1/bot-management/me`
  when a session needs a chatbot id but none was configured explicitly.
- **Packaged agent source validation**: Official/package GitHub installs now
  require exact directory matches, reject `.claw` shorthand guesses, and keep
  external install skipping explicit.
- **Web chat composer focus styling**: Restored an accessible focus ring while
  removing the extra focus border regression in the built-in chat surface.

## [0.9.3](https://github.com/HybridAIOne/hybridclaw/tree/v0.9.3)

### Added

- **Hugging Face provider support**: Added `hybridclaw auth login|status|logout`
  support for Hugging Face Inference providers, provider probing in `doctor`,
  model-catalog discovery, and recommended-model handling for
  `huggingface/...` model ids.
- **Admin jobs board and scheduler follow-ups**: Added a dedicated `Jobs`
  page in the embedded admin console with richer scheduler metadata, kanban
  views, and job movement/edit flows for proactive agent work.
- **Built-in tool toggles**: Added `hybridclaw tool list|enable|disable` so
  operators can trim unused built-in prompt surfaces directly from runtime
  config when `doctor` flags them.

### Changed

- **Container bootstrap and publish verification**: Installed packages now
  prefer published runtime images while source checkouts build locally, and
  the publish workflow verifies pushed GHCR tags before the job completes.
- **Skill metadata parsing cleanup**: Consolidated frontmatter traversal and
  metadata grouping in the skill loader so HybridClaw prefers native
  HybridClaw metadata while still handling OpenClaw-compatible skill manifests
  more predictably.

### Fixed

- **Scheduled delivery and backlog retry reliability**: Tightened scheduler
  follow-up handling, admin/API job state updates, backlog retries, and
  channel/email delivery flows so queued jobs recover more predictably after
  failures.
- **Router-provider credential normalization**: Shared API-key lookup and base
  URL normalization across OpenRouter and Hugging Face so auth setup, runtime
  credential resolution, and provider diagnostics behave more consistently.
- **Skill install/sync path stability**: Stabilized installed and synced skill
  paths, prevented path collisions during sync, and deduplicated install specs
  independent of key order so repeated skill installs are safer and more
  consistent.
- **Malformed `requires` handling for skills**: HybridClaw now warns when a
  skill declares malformed `requires` metadata instead of silently accepting
  broken dependency declarations.

## [0.9.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.9.2)

### Added

- **Skill sync and packaged Datalion workflow**: Added `skill sync`, updated
  TUI help/commands, shared import-argument parsing, and the repo-shipped
  Datalion community skill with bundled setup/capabilities docs.
- **Meme generation community skill**: Added a packaged meme-generation skill
  with reusable scripts, template data, and cached output reuse for community
  image workflows.
- **Workspace search hardening**: Added stricter workspace `glob` and `grep`
  handling in the container runtime for safer repository searches.

### Changed

- **Web chat branching and history flow**: Improved web chat controls,
  branch-aware history routing, paging persistence, and related stdin/history
  handling so browser sessions behave more predictably.
- **Shared type and search-tool internals**: Split the old shared type barrel
  into focused modules and moved container search logic into a dedicated
  `search-tools` module.
- **Skill import UX cleanup**: Centralized import warning text, shared the
  skill-import argument parser, removed sync/skip-scan quick entries from
  menus, and simplified optional import-result guard fields.

### Fixed

- **WhatsApp restart and ack recovery**: Reduced restart replay failures,
  captured and cleared ack reactions more reliably, dropped timestampless
  append-history writes, and hardened reconnect handling.
- **TUI history-arrow behavior**: Restored arrow-key prompt history when the
  slash menu has no matches while keeping those keys reserved for history
  navigation.
- **Agent skill overwrite protection**: `agent install` now requires
  `--force` before overwriting imported skills instead of silently replacing
  existing content.
- **Static docs publishing and QMD paging stability**: Synced the static docs
  shell with the gateway renderer, added `.nojekyll` for GitHub Pages, and
  persisted branch paging state while quieting QMD timeout noise.
- **Meme skill runtime hardening**: Tightened meme fetch error handling,
  file-path validation, and cache reuse so the packaged skill is safer and
  cheaper to run repeatedly.

## [0.9.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.9.1)

### Added

- **Inline prompt context references**: Added `@file:`, `@folder:`, `@diff`,
  `@staged`, `@git:<count>`, and `@url:` so prompts can pull repository or web
  context directly.
- **Current-turn web chat and TUI attachments**: Added upload/paste support
  for files and clipboard media in the built-in chat UI and TUI, including
  uploaded-media summaries for supported content.
- **Community skill imports and docs browser**: Added `hybridclaw skill import`
  and `skill learn`, packaged and hub-backed skill sources, manifest-declared
  skill imports during `.claw` install, and the built-in `/development` docs
  browser with raw-markdown views.

### Changed

- **Gateway/provider health probing**: Status endpoints now use TTL-cached
  on-demand probes for HybridAI and local backends instead of background
  polling loops, with async status flow and better probe-site error handling.
- **CLI command structure**: Split the large CLI handlers into focused command
  modules with shared lazy-loader and flag-parsing helpers.
- **Skill import source coverage**: Community imports expanded from packaged
  sources into hub-backed and GitHub-backed skill sources, with web docs
  navigation updated to expose the new workflows.

### Fixed

- **HybridAI base-url reachability reporting**: `/api/status` and operator
  hints now honor `HYBRIDAI_BASE_URL` consistently and probe actual backend
  reachability instead of assuming credentials imply connectivity.
- **Uploaded media hardening**: Tightened cache-dir resolution, path
  validation, MIME filtering, per-auth upload quotas, and filename handling
  for web chat and TUI attachments.
- **Context-reference safety and command preservation**: Blocked symlink
  escapes, URL redirects, and unbounded URL fetches for attached prompt
  context while preserving skill invocations with injected context.
- **CLI install output for imported skills**: `agent install` now tolerates
  missing imported skills in the CLI summary instead of failing the output
  path.

## [0.9.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.9.0)

### Added

- **Portable `.claw` agent packages**: Added `hybridclaw agent pack`,
  `inspect`, and `unpack` so operators can export an agent workspace, bundle
  selected workspace skills and home plugins, validate manifests, and restore
  agents on another machine from one archive.
- **Persistent browser profiles for authenticated automation**: Added
  `hybridclaw browser login|status|reset` so operators can sign into sites in a
  headed Chromium profile that HybridClaw reuses for later browser automation
  without pasting credentials into chat.
- **HybridAI discovery and non-interactive bootstrap controls**: Added
  `hybridclaw auth login hybridai --base-url <url>`, live HybridAI model
  discovery from `/models` with `/v1/models` fallback, `HYBRIDCLAW_DATA_DIR`
  for relocating runtime state, and `HYBRIDCLAW_ACCEPT_TRUST=true` for
  headless trust acceptance during onboarding or CI startup.

### Changed

- **TUI exit and streamed formatting flow**: The TUI now requires a second
  `Ctrl-C` or `Ctrl-D` within five seconds to exit, and it preserves streamed
  trailing blank lines more cleanly around usage footers and prompt refreshes.
- **Container publishing workflow**: Maintainers can republish release images
  through `publish-container.yml` via `workflow_dispatch`, with explicit
  tag/package validation before GHCR and optional Docker Hub pushes.

### Fixed

- **Web auth callback token handoff**: `/auth/callback` now accepts a safe
  relative `next` path, stores `WEB_API_TOKEN` in browser `localStorage` before
  redirecting, and rejects absolute, protocol-relative, and control-character
  redirect targets to prevent open-redirect and CRLF injection issues.
- **Published runtime image completeness**: The published Docker image now
  includes the built `/chat` and `/agents` SPA assets, and the root npm
  workspace includes `container` so dependency installs stay aligned with the
  shipped runtime.
- **HybridAI and runtime edge-case hardening**: Tightened HybridAI bot/model
  fetch timeouts and error reporting, added `HEALTH_HOST` override support for
  sandbox health checks, and improved container/runtime path handling around
  browser profiles and startup checks.

## [0.8.4](https://github.com/HybridAIOne/hybridclaw/tree/v0.8.4)

### Added

- **Local plugin runtime and admin plugin visibility**: Added local plugins
  with typed manifests, plugin tools, memory layers, prompt hooks, lifecycle
  hooks, CLI/TUI `plugin` management commands, and a dedicated `Plugins` page
  in the embedded admin console.
- **Installable QMD memory plugin**: Added the repo-shipped
  `plugins/qmd-memory` source plus maintainer docs for markdown-backed
  retrieval and optional session-transcript export into QMD collections.
- **In-loop context compaction guard**: Added token-budget-aware context
  compaction with reusable guard config so long sessions can flush durable
  memory and trim prompt context before requests exceed model budgets.
- **Recalled memory citations**: Added citation metadata for recalled memory
  snippets so injected context can be traced back to its originating memory.

### Fixed

- **Docker runtime packaging and login redirect gating**: Fixed the published
  container image startup path by shipping `container/shared/` in the runtime
  stage, and restricted browser login redirects to Docker deployments instead
  of forcing them on localhost web sessions.
- **Cloudflare-tolerant web fetch retries**: `web_fetch` can retry with a
  bot-style user agent when the first attempt lands on a Cloudflare challenge
  page.
- **Model catalog sync and LM Studio metadata handling**: Synced HybridAI bot
  models and display labels more consistently, and restored LM Studio v1
  context-window metadata detection.

## [0.8.3](https://github.com/HybridAIOne/hybridclaw/tree/v0.8.3)

### Added

- **Landing-page release highlights**: Added the 0.8.1 and 0.8.2 user-facing
  updates to the docs landing page so the latest shipped changes are visible
  from the project site.

### Fixed

- **Browser click fallbacks for JS-only cards**: `browser_click` can fall back
  to visible text or CSS selectors when snapshot refs are missing, resolves a
  likely clickable ancestor before dispatching the click, keeps provider-safe
  tool schema metadata, and preserves backward-compatible mixed-target
  priority of `text`, then `selector`, then `ref`.

## [0.8.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.8.2)

### Added

- **Refined TUI startup banner**: Added a richer terminal startup banner with
  active model, default model, sandbox mode, gateway URL, provider context,
  chatbot id, slash-command overview, and a more distinctive visual layout.

### Fixed

- **Discord invalid-token startup handling**: Gateway startup now disables the
  Discord integration when the configured token is invalid instead of failing
  the wider runtime startup path.

## [0.8.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.8.1)

### Added

- **Opt-in gateway request logging**: Added `--log-requests` to
  `hybridclaw gateway start|restart` so operators can persist best-effort
  redacted prompts, responses, and tool payloads in SQLite `request_log` for
  debugging. Typed text sent through `browser_type` is always redacted.

### Fixed

- **Gateway request logging safeguards**: Tightened opt-in request-log
  parsing and redaction so unsupported env values are ignored, secret-like
  query parameters are scrubbed, and failed turns only record when a
  sanitized request payload exists.
- **Browser snapshot clickability on custom UIs**: `browser_snapshot` now
  enables cursor-aware clickable refs in every mode, so pointer-driven cards
  and other custom controls without ARIA roles are more reliably discoverable
  and clickable.
- **Vitest stability and release-bump resilience**: Pinned Vitest back to
  `4.0.18` to restore test isolation stability after the `4.1.0` behavior
  change, and removed hardcoded release-version assertions from the WhatsApp
  connection tests.

## [0.8.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.8.0)

### Added

- **Adaptive skills loop**: Added `adaptiveSkills` configuration plus
  `hybridclaw skill inspect|runs|amend|history`, guarded amendment staging,
  and admin `Skills` health/amendment review so HybridClaw can observe skill
  runs and improve `SKILL.md` instructions over time.
- **Doctor diagnostics command**: Added `hybridclaw doctor [--fix|--json|<component>]`
  with parallel runtime, gateway, config, credentials, database, providers,
  local-backends, Docker, channels, skills, security, and disk checks plus
  safe auto-remediation where supported.
- **Microsoft Teams channel**: Added Teams channel support with
  `hybridclaw auth login msteams`, inbound webhook handling, streaming and
  attachment-aware replies, allowlist-based DM/channel policies, and gateway
  visibility so one assistant can work across Discord, Teams, WhatsApp,
  email, web, and TUI surfaces.
- **Per-channel skill controls and TUI skill config**: Added global and
  per-channel skill disable lists for Discord, Teams, WhatsApp, and email,
  CLI `skill enable|disable|toggle` controls, and a TUI `/skill config`
  checklist for editing them interactively.
- **TUI session resume flow**: Added `hybridclaw tui --resume <sessionId>`
  and `hybridclaw --resume <sessionId>` plus exit summaries that show
  input/output token breakdowns, file/tool counts, and a ready-to-run resume
  command for the current canonical TUI session.
- **Extensible session routing**: Added marker-based canonical session keys,
  `main_session_key` continuity scopes, explicit malformed-key detection, and
  configurable DM routing so operators can keep direct messages isolated by
  channel/peer or intentionally collapse verified aliases onto one linked
  identity.
- **Bundled workflow and app skills**: Added bundled skills for planning,
  review, publishing, and operations workflows plus integrations for Notion,
  Trello, GitHub PRs, Google Workspace, Discord, Himalaya email, 1Password,
  Stripe, WordPress, and Apple Calendar/Passwords/Music.
- **TUI slash menu and history recall**: Added inline slash-command discovery,
  help aliases, prompt history recall, and improved numbered approvals in the
  terminal client.

### Changed

- **Automatic session reset policy**: Upgrading to the session-reset policy
  feature enables automatic resets by default (`mode: "both"`, `atHour: 4`,
  `idleMinutes: 1440`). Operators who need the previous retention behavior
  should set `sessionReset.defaultPolicy.mode` to `none`; automatic resets now
  log the `sessionId`, incremented `resetCount`, and expiry `reason` at INFO
  level. The daily `atHour` boundary is evaluated in the gateway host's local
  timezone, not UTC.
- **Tool execution throughput**: Safe read-only tool calls can batch in
  parallel while loop-guarded tools remain sequential and deferred approvals
  still fall back safely.
- **Operator defaults and provider signals**: OpenRouter requests send
  app-attribution headers, bot-set actions emit observability/audit events,
  and the email channel default poll interval is 30 seconds.
- **Web and local session defaults**: Anonymous web chats now get unique
  canonical session ids instead of sharing a default DM session, built-in
  `/chat`, `/agents`, and `/admin` surfaces honor `WEB_API_TOKEN` when
  configured, API command/history calls fail closed without an explicit
  `sessionId`, and TUI, Teams, email, WhatsApp, heartbeat, and scheduler
  flows now emit canonical transport keys directly at ingress.

### Fixed

- **Operator diagnostics and hot-reload stability**: Tightened `doctor`
  diagnostics, foreground gateway PID handling, and runtime-config watcher
  recovery after transient `EMFILE` failures so local repair and hot-reload
  flows stay actionable.
- **Microsoft Teams runtime hardening**: Tightened Teams send permissions,
  media handling, and streaming behavior across DM and channel replies.
- **Approval and media UX**: Preserved Discord approval artifacts and rendered
  fallbacks, kept TUI approvals in the numbered flow, and hardened managed
  media cleanup plus Discord CDN idle/close handling.
- **Scheduler and reset edge cases**: Normalized scheduler cron timezone
  handling, guarded reset timestamp parsing, inferred reset channel kinds more
  reliably, and cleared semantic memories during session reset.

## [0.7.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.7.1)

### Added

- **Admin console and agent dashboards**: Added the embedded `/admin` console
  and `/agents` workspace/session dashboards so operators can inspect gateway
  state, sessions, channels, config, models, scheduler tasks, MCP servers,
  audit events, skills, and tools from the browser.
- **Full-auto session mode**: Added supervised `fullauto` execution with queued
  proactive delivery, persisted startup resume, watchdog recovery, and explicit
  interruption when a human takes over the session.
- **First-class agents**: Agents now own workspaces independently of the active
  model provider, with `agent` commands exposed through the gateway, TUI, and
  Discord for creating, listing, switching, and inspecting agent bindings.
- **WhatsApp, email, and cross-channel messaging**: Added WhatsApp channel
  integration, a native email channel, replay/message-store support, auth reset
  tooling, and shared `message` routing so HybridClaw can send and normalize
  delivery across Discord, WhatsApp, email, and local channels.
- **Shared audio transcription and OpenRouter auth**: Added inbound audio
  transcription fallbacks across local CLIs and provider backends plus
  `hybridclaw auth login|status|logout openrouter` for provider-aware
  authentication and model selection.

### Changed

- **Stable workspace identity across model/provider changes**: Session
  workspaces are keyed by agent identity instead of provider-derived agent IDs,
  so switching models or providers keeps the same workspace and memory unless
  the session is explicitly rebound.
- **Session visibility and status controls**: Added
  `show all|thinking|tools|none` across gateway, TUI, Discord, and web chat,
  while shared status output now includes the current session agent and
  effective model.
- **Media and prompt routing**: Current-turn attachments and media now flow
  through shared routing for Discord, WhatsApp, email, and local clients,
  including native vision/audio injection paths and stronger preference for
  current-turn local files over history rediscovery.
- **Auxiliary task/provider routing**: Added Hermes-style auxiliary routing and
  tighter provider fallback handling so deferred or background tasks pick the
  right model more predictably.
- **Discord activation config cleanup**: Removed the obsolete
  `discord.respondToAllMessages` config path. Guild activation now follows
  `channel mode`, guild policy, and explicit free-response channel settings.

### Fixed

- **Approval/runtime guard hardening**: Tightened approval confirmation flows,
  tool runtime guards, and gateway/runtime follow-up handling so blocked or
  long-running turns fail more predictably.
- **Agent, TUI, and heartbeat stability**: Improved TUI streaming and silent
  reply handling, stabilized agent dashboards and heartbeat activity tracking,
  and preserved visibility on long-running turns.
- **WhatsApp and email delivery reliability**: Fixed WhatsApp auth-lock races,
  timeout handling, follow-up delivery edge cases, local message-store
  persistence, and email runtime/delivery hardening.
- **Audio/media path handling**: Hardened audio transcription media-path
  resolution, PDF truncation, and current-turn media handling across gateway
  and container paths.
- **Discord media cache hardening**: Added SSRF-guarded Discord CDN fetches,
  per-type cache limits, Unicode-aware filename sanitization, explicit
  permissions, and lazy TTL-based cleanup with empty-directory pruning for
  cached inbound media.

## [0.6.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.6.0)

### Added

- **Local LLM provider support**: Added Ollama, LM Studio, and vLLM as local
  backends with `hybridclaw local configure|status`, auto-discovery of running
  instances, health monitoring, model catalog management, thinking extraction,
  and tool-call normalization for small local models.
- **Session reset flow**: Added `reset [yes|no]` across gateway/TUI and Discord
  slash commands so a session can clear history, restore per-session
  model/chatbot/RAG defaults, and remove the active agent workspace after
  confirmation.
- **Activity-based agent timeout**: The IPC read timeout now resets on agent
  activity (text deltas, tool progress) instead of using a fixed wall clock,
  so slow local models making steady progress are not killed prematurely.

### Fixed

- **Host sandbox `/workspace` references**: System prompt skill locations and
  tool guidance now use real filesystem paths when `sandbox=host` instead of
  the container-only `/workspace` mount path that does not exist on the host.
- **Local provider session stability**: Pooled workers now restart when backend
  targets or auth signatures change, recreated workspaces clear stale session
  transcript state, and missing workspace approval policies are bootstrapped
  reliably.
- **Session compaction budget accuracy**: Auto-compaction now counts system
  prompt tokens instead of only message and summary tokens, so compaction
  triggers at the configured threshold.
- **Misleading timeout error message**: Changed "Timeout waiting for container
  output" to "Timeout waiting for agent output" since the same IPC mechanism
  is used by both host and container runners.

## [0.5.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.5.0)

### Added

- **Model Context Protocol support**: Added runtime `mcpServers` config plus container MCP client loading so HybridClaw can expose configured MCP servers as namespaced tools, with TUI `/mcp list|add|toggle|remove|reconnect` management commands.
- **Discord slash command control plane**: Added global Discord slash commands for status, approvals, compaction, channel policy, model/bot selection, RAG, Ralph loop, MCP management, usage, export, sessions, audit, and scheduling, with private approval responses.
- **Bundled office document skills**: Added `docx`, `xlsx`, `pptx`, and `office-workflows` bundled skills plus shared office helper scripts for OOXML pack/unpack, tracked-change cleanup, spreadsheet import/recalc, and presentation thumbnail QA.
- **Authenticated artifact downloads**: Added gateway `/api/artifact` serving for generated agent artifacts and cached Discord media so the web chat can render previews and download generated office outputs safely.

### Changed

- **Runtime capability guidance**: Prompt/tool summaries now group MCP tools cleanly and add office-file guardrails so models avoid fake binary placeholders and follow document QA workflows.
- **Discord delivery workflow**: The Discord `message` tool now supports native local-file uploads via `filePath`, and runtime delivery/register flows better handle workspace files, `/discord-media-cache`, and DM-visible global slash commands.
- **Documentation and examples**: README, runtime docs, and built-in web/chat surfaces now document MCP setup, bundled office skills, and artifact handling for the new workflows.

## [0.4.3](https://github.com/HybridAIOne/hybridclaw/tree/v0.4.3)

### Added

- **Manual session compaction command**: Added built-in `/compact` support across gateway, TUI, and Discord to archive older transcript history, summarize it into high-confidence session memory, and preserve a recent conversation tail for active context.
- **Bundled PDF workflow support**: Added a built-in `pdf` skill plus Node-based PDF tooling for text extraction, page rendering, fillable form inspection/filling, and non-fillable overlay workflows, with current-turn PDF context injection for explicit file paths and Discord attachments.
- **Skill installer commands**: Added `hybridclaw skill list` and `hybridclaw skill install <skill> [install-id]` so bundled skills can advertise optional dependency installers.
- **Container bind path config**: Added `container.binds` support alongside validated host/container path aliasing so configured external directories can be used safely from sandboxed tools and PDF workflows.
- **Published coverage badge**: CI now generates and publishes a coverage badge JSON artifact for the README badge and release-health visibility.

### Changed

- **Attachment and media routing**: Gateway/media prompt assembly now distinguishes image attachments from document attachments, prefers current-turn local files for PDFs, and limits native vision injection to actual image inputs.
- **Contributor documentation structure**: Promoted `AGENTS.md` to the canonical repo-level agent guide, slimmed `CONTRIBUTING.md` into a contributor quickstart, and moved deeper maintainer/runtime references into `docs/development/`.
- **Host runtime workspace setup**: Host-mode agent workspaces now link package `node_modules`, while runtime path handling and workspace globbing understand configured extra mounts and local scratch paths more reliably.
- **Release metadata and docs alignment**: The published package now declares `Node 22.x`, README badges point at maintained badge sources, and the docs landing page tracks the current tagged release/version requirements.
- **Regression coverage**: Added focused unit coverage for memory chunking, gateway startup/health flows, Discord delivery chunking, PDF context handling, and compaction paths.

### Fixed

- **Compaction archive path exposure**: `/compact` responses now show a safe archive reference instead of leaking absolute host filesystem paths in user-facing output.
- **Workspace bootstrap lifecycle**: `BOOTSTRAP.md` is now removed once onboarding is effectively complete and is not recreated on subsequent starts.
- **Codex device-code activation flow**: Device-code login now falls back to the default activation URL and tolerates nested pending/authorization error payloads from the auth service.
- **Runtime-home migration false positive**: Launching HybridClaw from `~/.hybridclaw` no longer treats the runtime `data/` directory as a legacy current-working-directory migration target.
- **Heartbeat proactive queue cleanup**: Local proactive delivery now drops orphaned heartbeat queue rows instead of trying to route them as real outbound messages.
- **Coverage badge publishing permissions**: CI now has the repository permissions needed to update the published coverage badge without failing the main workflow.

## [0.4.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.4.2)

### Added

- **Gateway debug tracing**: Added `hybridclaw gateway start|restart --debug` to force debug logging and emit request-stage traces across Discord intake, gateway chat handling, container model calls, and Codex streaming transport.

### Changed

- **Unified configured model catalog**: Discord slash commands, gateway model commands, and TUI model selection now all consume the same deduplicated configured model list derived from runtime config.
- **Startup path reliability**: TUI now attaches to a reachable gateway without redundant local runtime preflight, and the CLI resolves symlinked installs correctly so globally linked `hybridclaw` commands no longer exit silently.

### Fixed

- **Discord DM trigger suppression**: Greeting-only direct messages are no longer dropped by the guild-oriented auto-suppress filter before they reach the model pipeline.
- **Container refresh fallback**: Gateway restart now keeps using an existing local image if a stale-image rebuild attempt fails, instead of aborting despite a usable runtime image.

## [0.4.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.4.1)

### Added

- **HybridAI auth commands**: Added `hybridclaw hybridai login`, `status`, and `logout` commands with browser-assisted, headless/manual, and env-import flows backed by the existing `~/.hybridclaw/credentials.json` secrets store.

## [0.4.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.4.0)

### Added

- **OpenAI Codex OAuth support**: Added `hybridclaw codex login`, `status`, and `logout` commands with browser PKCE, device-code, and Codex CLI import flows backed by a dedicated `~/.hybridclaw/codex-auth.json` store.
- **Provider-aware model selection**: Runtime config and onboarding now support `openai-codex/...` models alongside HybridAI models, including an expanded default Codex model catalog and provider-specific credential routing.

### Changed

- **Human-readable tool summary in prompts**: System prompts now include a compact grouped tool inventory, and delegated subagents see the same summary filtered to their actual allowed toolset so plain-language tool selection guidance reinforces the API schemas.
- **Gateway/runtime provider plumbing**: Gateway status output now surfaces Codex auth state, model resolution routes provider-prefixed models through dedicated adapters, and the container runtime uses provider-specific model clients.

### Fixed

- **Web-vs-browser tool routing**: Prompt guidance now pushes read-only retrieval toward `web_fetch`, while gateway media routing avoids `browser_vision` for Discord-uploaded images unless the task is explicitly about the active browser tab.

## [0.3.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.3.1)

### Changed

- **Home-only runtime state**: Runtime config, credentials, and data now stay under `~/.hybridclaw` exclusively; onboarding writes `credentials.json`, existing `./.env` secrets are imported into that file for compatibility, and the CLI stops probing legacy `./config.json` / `./data` runtime files.
- **Container image state handling**: Container image fingerprint/state recording is now centralized, missing files are tolerated during fingerprint collection, and build/pull status lines use the invoking command name for clearer operator output.

### Fixed

- **Gateway lifecycle flag parsing**: `hybridclaw gateway start --sandbox=host` and `hybridclaw gateway restart --sandbox=host` no longer trip the top-level unsupported-flag guard, while non-lifecycle gateway subcommands still reject misplaced `--sandbox` / `--foreground` flags.

## [0.3.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.3.0)

### Added

- **Configurable sandbox modes**: Gateway start/restart now accept `--sandbox=container|host`, runtime config adds `container.sandboxMode`, and gateway/TUI status surfaces show the active sandbox mode so operators can avoid Docker-in-Docker when HybridClaw itself already runs inside a container.

### Changed

- **Container runtime hardening**: Container execution now drops Linux capabilities, disables privilege escalation, enforces a PID limit, uses a sized `/tmp` tmpfs, and adds `container.memorySwap` / `container.network` tuning alongside GHCR-first image pulls before the optional Docker Hub mirror.
- **Packaged host runtime**: Root builds now compile and ship `container/dist/` so host sandbox mode can launch the bundled agent runtime from installed npm packages.
- **Instruction sync workflow**: `hybridclaw audit instructions` now compares runtime copies in `~/.hybridclaw/instructions/` to installed package sources and uses `--sync` to restore shipped defaults instead of maintaining a local approval-hash baseline.

### Fixed

- **Release container publishing resilience**: Release-tag container publishing now always publishes GHCR even when Docker Hub credentials are absent, instead of failing before any registry push occurs.
- **Install-root asset resolution**: Runtime docs/templates/instructions now resolve from the actual install root, so onboarding, prompt guardrails, workspace bootstrap files, and the built-in site no longer depend on `process.cwd()`.

## [0.2.12](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.12)

### Added

- **Automatic container publishing**: Added release-tag GitHub Actions publishing to Docker Hub (`hybridaione/hybridclaw-agent`) plus GHCR mirror (`ghcr.io/<org>/hybridclaw-agent`) with versioned tags (`vX.Y.Z`) and stable `latest` updates.
- **Container build context guardrails**: Added `container/.dockerignore` and included it in npm package files so local secrets/artifacts are excluded from image build context.

### Changed

- **Runtime data default location**: Runtime config and data now default to `~/.hybridclaw` (`config.json`, `data/hybridclaw.db`, audit/session artifacts) to match home-directory workspace best practices.
- **Container bootstrap pull order**: Container readiness now pulls prebuilt images from Docker Hub first (`v<app-version>`, then `latest`) with GHCR fallback before local build.
- **README scope cleanup**: Reduced README to user-facing install/runtime guidance and moved maintainer/developer internals to `CONTRIBUTING.md`.
- **Container build script behavior**: `npm run build:container` now runs `docker build` directly without requiring host TypeScript tooling.

### Fixed

- **First-run migration completeness**: Startup now migrates legacy `./config.json` and `./data` into `~/.hybridclaw`, archives legacy files, and stores migration backups under `~/.hybridclaw/migration-backups/` on conflicts.
- **Install-root write issues**: Container image fingerprint state now persists under `~/.hybridclaw/container-image-state` (with legacy state fallback) instead of package install directories.
- **Duplicate Discord `/status` slash entries**: Slash command registration now keeps `status`/`approve` global-only and removes stale guild-scoped duplicates to avoid duplicate command entries in guild channels.

## [0.2.11](https://github.com/HybridAIOne/hybridclaw/tree/v0.2.11)

### Added

- **Model default controls across TUI/Discord**: Added `model default [name]` command support in gateway/TUI plus a Discord `/model` slash command (`info`, `default`) with configured model choices.
- **Local proactive reminder delivery path**: Added queued proactive pull API (`GET /api/proactive/pull`) and TUI polling so scheduler/heartbeat reminders reliably surface in `tui` channels.
- **Scheduler timestamp regression test**: Added coverage for legacy SQLite second-precision timestamps and interval due-time regression handling.

### Changed

- **Cron tool reminder contract**: Cron `add` now accepts prompt aliases (`prompt`/`message`/`text`), supports relative one-shot scheduling via `at_seconds`, and documents prompt-as-instruction semantics for future model runs.
- **Scheduler prompt framing**: Scheduled model turns now explicitly instruct execution of the provided instruction without follow-up questions.

### Fixed

- **SQLite timestamp interpretation drift**: Scheduler now normalizes legacy `YYYY-MM-DD HH:MM:SS` task timestamps as UTC, preventing immediate re-fire bugs on interval tasks after timezone conversion.
- **Silent reply normalization edge case**: API/stream silent-token replacement now emits `Message sent.` only for real `message` send actions and otherwise falls back to the latest successful tool result.

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
