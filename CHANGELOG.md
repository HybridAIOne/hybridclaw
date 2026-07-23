# Changelog

## Unreleased

### Added

- **Once-per-release console updates**: The admin console shows an ultra-short
  What's New dialog once for each release, and the sidebar version number
  reopens it on demand.

## [0.28.3](https://github.com/HybridAIOne/hybridclaw/tree/v0.28.3) - 2026-07-22

### Fixed

- **HybridAI activity notifications now show the actual user prompt**:
  interactive agent turns send the raw user text as transient request metadata,
  separately from the compiled model context. Background turns omit the field,
  and confidential values are redacted before the prompt crosses the sandbox
  boundary.

- **Prompt-cache usage is now visible through the OpenAI-compatible API**: the
  gateway parsed upstream cache reads and writes internally but dropped them
  when building the response, so clients could not tell a cold cache from a
  fully cached prompt. `usage` now carries `prompt_tokens_details.cached_tokens`
  (and `cache_creation_input_tokens` when the provider reports cache writes),
  emitted only when the provider actually reported cache usage — a missing
  field means "not reported" while an explicit `0` means "no cache hit". The
  tool-aware passthrough path previously hard-coded cache usage to zero and now
  reads both OpenAI-style (`prompt_tokens_details.cached_tokens`) and
  Anthropic-style (`cache_read_input_tokens`) spellings.

- **Cloud and Docker sandbox tool execution**: The gateway host-sandbox image
  and standalone agent image include Python, pip, `openpyxl`, `unzip`, `file`,
  and compatible XLSX libraries with resolvable Node module paths, restoring
  spreadsheet inspection and manipulation in cloud deployments. Prompts that
  mention versions or commands such as `python3 --version` also reach the agent
  instead of being intercepted by the former HybridClaw-version shortcut.
- **Admin console reliability**: Tab bars keep a stable, pinned layout with
  contextual controls in the tab row; provider health appears only on the
  Providers page with readable rows; generated settings replace build-host
  home directories with portable `~/` paths; and redundant owned settings no
  longer appear as editable duplicates.
- **Agent archive migration**: Existing databases whose schema version `52`
  came from the parallel agent-sharing migration still add the archived-agent
  column through a collision-free version `53` migration.
- **Install-on-demand channel plugins**: The Channels page offers to install a
  missing WhatsApp transport, package-name resolution finds locally installed
  plugins, and the generalized channel-plugin path preserves setup and doctor
  behavior after the transport is removed from core.
- **Release metadata walks**: Dependency-policy, SBOM, and third-party-notice
  generators skip every dot-directory, preventing auxiliary Git worktrees from
  being scanned as duplicate or partially updated package trees.
- **Bundled tier-router packaging**: npm and gateway Docker artifacts include
  the deterministic tier-router plugin required when `routing.enabled` is set,
  and the release check now fails if any of its runtime files are missing.

### Added

- **A2A end-to-end transport encryption**: Paired HybridClaw gateways exchange
  and pin dedicated X25519 keys, encrypt message envelopes with compact JWE
  (`ECDH-ES` and `A256GCM`), bind encrypted envelopes to Ed25519-signed
  delegation tokens, reject per-peer plaintext downgrades, and expose an admin
  switch that requires E2EE for every A2A trust entry.
- **Deterministic model-tier routing**: Operators can define an ordered
  `routing.tiers[]` ladder across hosted and named local models. Unpinned agent
  turns start from the agent's configured rung or `routing.defaultStart`, while
  heartbeat, scheduler, and full-auto turns begin at the lowest rung. Provider
  auth, rate-limit, and server failures, malformed tool calls, and persistently
  empty or narrate-only answers escalate safely; successful escalation can stay
  sticky for subsequent turns, `/escalate` raises the next unpinned turn by one
  rung, and request/session model pins remain hard overrides. Routing attempts
  and escalation reasons are recorded in the audit trail.
- **Local model privacy and pricing metadata**: Named local endpoints can
  declare a `local`, `hai`, `region`, or `cloud` zone plus input/output EUR
  prices per million tokens. Model info, usage accounting, and the admin Models
  page preserve unknown prices instead of silently treating unpriced endpoints
  as free.
- **Searchable admin configuration**: The admin shell exposes page and setting
  search from the sidebar or `Cmd/Ctrl+K`. A generated registry makes every
  runtime setting discoverable by label, description, and dotted path; results
  open the exact setting or its canonical owner page, and the Providers page
  owns provider enablement, endpoint, auth method, and SecretRef setup.
- **Model latency benchmark**: `scripts/benchmark-model-latency.mjs` measures
  time-to-headers, time-to-first-token, total duration, and tokens/sec for the
  same model across three paths — the local gateway's OpenAI-compatible API
  (full agent turn), the HybridAI API called directly, and the model vendor
  (Anthropic or OpenAI) called directly — each with streaming on and off.
  Request bodies mirror the exact shapes HybridClaw sends, so latency deltas
  attribute slow responses to the HybridClaw layer, the HybridAI backend, or
  the upstream vendor. Connection preflight separates DNS/TCP/TLS handshake
  cost per origin; cache-hit reporting distinguishes unavailable data from a
  real zero; multiple gateway provider arms can be compared side by side; and
  long prompts can be loaded from a file for meaningful throughput tests.
- **Direct OpenAI API provider**: `openai/...` models use the OpenAI Responses
  API with encrypted `OPENAI_API_KEY` storage, streaming, function calling,
  stateless encrypted reasoning-item replay, model catalog metadata, CLI auth,
  gateway health, and doctor diagnostics. Codex OAuth remains available under
  the separate `openai-codex/...` provider.
- **Codex 5.6 models**: `openai-codex/gpt-5.6-sol`, `openai-codex/gpt-5.6-terra`,
  and `openai-codex/gpt-5.6-luna` are now recognised as forward-compatible Codex
  models, so they are selectable as soon as the Codex account offers them
  instead of waiting for the discovery endpoint to list them.
- **Dependency license gate**: `scripts/check-dependency-policy.mjs` now scans
  every tracked `package-lock.json` and fails on GPL, AGPL, and SSPL-family
  licenses unless the exact `name@version` and license pair is approved under
  `licenses` in `scripts/dependency-policy-baseline.json`. Weak-copyleft
  licenses such as LGPL and MPL, and packages with missing license metadata,
  are reported without failing, and dual-licensed packages resolve to their
  most permissive option. The gate runs in every existing dependency-policy
  entry point: the pre-commit hook, the CI lint job, `npm run deps:policy`,
  and `npm run release:check`.
- **Release IP and provenance artifacts**: Distributed components declare MIT
  license metadata; `THIRD_PARTY_NOTICES.md` inventories production packages,
  deduplicated license texts, and required NOTICE content; release CI generates
  per-component CycloneDX and SPDX SBOMs; and pull requests enforce Developer
  Certificate of Origin sign-offs. A public provenance statement documents the
  project's independent history, contributor ownership, third-party intake,
  and relationship to OpenClaw.

### Changed

- **Admin workflows and navigation**: The console groups related work into
  Activity, Agents, Automation, Federation, Credentials, and Extensions tabbed
  pages; settings live on one canonical owner surface; legacy admin URLs
  redirect to the matching tab; contextual controls stay attached to their
  active tab; and non-default agents can be archived without deleting their
  files or history.
- **Install-on-demand WhatsApp transport**: WhatsApp ships as the separate
  `@hybridaione/hybridclaw-whatsapp` plugin so Baileys and its GPL-3.0
  `libsignal` dependency are excluded from core npm, Docker, desktop, and
  Homebrew artifacts. Existing linked sessions remain in
  `~/.hybridclaw/credentials/whatsapp`; install the transport with
  `hybridclaw plugin install @hybridaione/hybridclaw-whatsapp`.
- **Secret inspection terminology**: `hybridclaw secret status <NAME>` and
  `/secret status <NAME>` replace the misleading `secret show` spelling. The
  command reports only whether a secret exists and never decrypts or prints its
  value.
- **AGPL removed from the dependency tree**: `camoufox-js` now resolves
  `ua-parser-js` 1.0.41 (MIT) through a scoped npm override instead of 2.0.10
  (AGPL-3.0-or-later), retiring the `ua-parser-js@2.0.10` AGPL exception from
  the license baseline. Known regression: `camoufox-js` matches the v2 spelling
  `"macOS"` when deriving the target OS, so under v1 (`"Mac OS"`) every macOS
  fingerprint is treated as Linux and receives Linux fonts, WebGL strings, and
  environment variables. Camofox stealth is degraded for macOS fingerprints
  until `determineUAOS` is patched.

## [0.28.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.28.2) - 2026-07-17

### Added

- **A2A local mode**: Operators can enable an A2A-only deployment posture from
  `/admin/a2a-trust`. Loopback and authenticated admin management remain
  available, Agent Card and A2A delivery routes stay reachable, and external
  chat, OpenAI-compatible APIs, webhooks, channel runtimes, and channel delivery
  are disabled.
- **Dedicated tunnel administration**: Public tunnel configuration and status
  now live on a focused admin surface with provider selection, URL validation,
  save/start/stop/reconnect controls, health details, and actionable errors.

### Changed

- **Google Workspace console OAuth**: Local consoles, including the desktop
  app, use Google's Desktop-client loopback flow without a registered redirect
  URI. Consoles opened through LAN, tunnel, or public origins use the Web-client
  flow and show the exact server-computed callback URI that must be registered.
- **Provider health defaults**: Local model backends, including Ollama, are
  disabled and unprobed until an operator enables them. Gateway health omits
  unused Codex warnings while retaining status when Codex is configured,
  selected, or authenticated.
- **Trace-to-message attribution**: Turn completion and onboarding audit events
  carry the stored assistant message id, and ATIF trace exports resolve that
  exact response for full or selected turn ranges. Missing references are
  reported as export limitations instead of shifting later responses onto the
  wrong turn.
- **Architecture design documentation**: Internal docs define the configurable
  model-tier ladder, deterministic escalation, privacy zones, quality/speed
  target, auditable savings metric, five testable delivery phases, and the
  companion HybridRouter SFT/PEFT roadmap. A separate SSO and per-user identity
  design specifies trusted-proxy and generic OIDC front doors, IdP group-to-role
  mapping, per-user sessions, per-agent ACLs, security boundaries, and phased
  delivery.

### Fixed

- **Microsoft Teams credential hot reload**: Setting or rotating
  `MSTEAMS_APP_PASSWORD` through the admin secret store refreshes the running
  gateway immediately, initializes Teams handlers that were waiting for
  credentials, and rebuilds the Bot Framework adapter without requiring a
  container restart. Adapter refresh detection no longer derives password
  hashes.
- **Model response streaming**: Provider text deltas reach clients as they
  arrive instead of being buffered until the final response. HybridClaw keeps
  classified Ralph drafts buffered, avoids replaying final text after a live
  stream, does not retry a failed model call after visible partial output, and
  accepts both cumulative and delta-style HybridAI chunks without duplicating
  content.
- **Concurrent session turns**: Gateway, host, and container execution serialize
  requests per session while allowing different sessions to run concurrently.
  Interactive input preempts an active full-auto turn before waiting on the
  session queue, preventing overlapping history writes or delayed intervention.
- **In-loop compaction tool exchanges**: Compaction boundaries keep assistant
  tool calls together with all immediately following tool results, including
  parallel calls, so providers never receive unanswered calls or orphaned
  results.
- **Anthropic and Ollama client tools**: Direct Anthropic and Ollama requests use
  their correct OpenAI-compatible request bodies, model ids, and completion
  URLs when client tools are present. Direct Anthropic streams are no longer
  terminated by a fixed total-duration cap.
- **WhatsApp self-chat echo prevention**: Outbound message ids are registered
  with the echo guard as soon as each chunk is sent, before slower persistence
  work can let a reflected message start another agent turn.
- **Inline PDF previews**: Artifact PDFs render in Chrome without the sandboxed
  iframe block while the preview blob is pinned to `application/pdf` so
  mislabeled content cannot become same-origin HTML.

## [0.28.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.28.1) - 2026-07-10

### Added

- **LINE personal-account self-chat channel**: Operators can link a personal
  LINE account through an explicitly warned unofficial QR flow and use only
  that account's self-chat for agent turns. Auth tokens, E2EE state, and sync
  cursors persist across restarts; sender/recipient checks, reply-prefix loop
  prevention, process locking, self-only outbound enforcement, CLI setup and
  reset commands, and admin-console QR status keep the transport scoped to the
  linked account.

### Fixed

- **Onboarding autostart visibility and retry**: First-run assistant-only
  sessions are preserved while bootstrap autostart is active or awaiting the
  user's reply, and temporary provider failures can retry without consuming a
  hatching turn or hiding the onboarding opener.
- **Channel delivery size limits**: Long replies now obey the configured hard
  character and line limits across Discord replies, streams, and webhooks plus
  Slack webhooks. The shared chunker safely splits unbroken text and Unicode,
  reserves room for closing code fences, and reopens fenced blocks in the next
  chunk.
- **Duplicate channel turn dispatch**: Discord ignores metadata-only message
  updates, Slack coalesces twin `message` and `app_mention` events while
  retaining attachments, and WhatsApp resolves alternate phone JIDs for LID
  senders so one inbound message does not start duplicate or misidentified
  turns.
- **Auxiliary model output caps**: Explicit task-level `maxTokens` values are
  preserved even when model discovery has no provider maximum, preventing
  auxiliary calls from silently losing their requested output limit.
- **Anthropic thinking traces**: Direct Anthropic and HybridAI-routed Claude
  streams preserve structured thinking content through tool-call continuations
  and expose it to the chat activity trace instead of dropping it between
  turns.
- **CLI self-update output and footprint**: npm self-updates omit development
  dependencies and suppress non-actionable deprecation, funding, and audit
  noise while continuing to surface installation errors.

## [0.28.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.28.0) - 2026-07-08

### Added

- **A2A inbox dispatch and reply-back chat**: Trusted inbound A2A messages now
  persist through the gateway dispatch store, route to the target local agent,
  and send the agent's reply back to the originating instance when reverse
  trust is present. The origin chat renders a compact delivery-status chip while
  the envelope is sent, received, and waiting for the remote reply.
- **Scoped API tokens**: Operators can create, list, and revoke gateway API
  tokens with explicit action, scope, role, or roles claims from the new
  `hybridclaw token` CLI and `/admin/tokens` console page. Tokens support
  expiry timestamps, one-time reveal, metadata-only listing, route-level RBAC,
  and audit events for creation and revocation.
- **Delegated OpenAI-compatible job retrieval**: Delegated
  `/v1/chat/completions` requests now expose `hybridclaw.delegation` metadata,
  return `X-HybridClaw-Delegation-Id` for non-streaming acknowledgements, and
  can be polled at `GET /v1/chat/completions/{completion-id}` until the queued
  job completes, fails, or is cancelled.
- **Published apps and Teams sharing**: Apps can now be published from the Apps
  gallery as scoped sharing links, optional password-protected links, or
  Microsoft Teams tabs. Publications are persisted with revocation, expiry,
  embed-host, and live-data bridge controls, and Teams tabs validate Entra SSO
  viewers before rendering shared app content.
- **A2A peer-pairing guide**: Public docs now include a browser pairing
  walkthrough and deterministic two-instance curl smoke test for trusted A2A
  chat, reverse trust, and reply delivery.

### Changed

- **Admin token roles and presets**: The token surfaces now prefer current
  least-privilege admin role bundles and clearer action grants while preserving
  compatibility role names where needed.
- **OpenAI-compatible delegated acknowledgements**: Streaming and
  non-streaming delegated completions carry consistent delegation metadata so
  local eval harnesses and compatible clients can correlate queued work with
  later retrieval.

### Fixed

- **Config watcher scope and EMFILE resilience**: The runtime-config file
  watcher now starts only in the long-running gateway process instead of in
  every CLI invocation, so one-shot commands such as `hybridclaw gateway
  status` no longer create `fs.watch` handles or interleave
  `[runtime-config] watcher error: EMFILE` retry noise into their output.
  When the gateway's watcher does fail (for example `EMFILE: too many open
  files`), config hot-reload now falls back to descriptor-free stat polling
  instead of going dark after ten failed watcher restarts.
- **A2A chat delivery stability**: Remote A2A replies now appear in the origin
  chat, local A2A smoke replies are stable, inbound audience resolution works
  behind public tunnels, and the delivery chip remains coherent across history
  reloads while disappearing after the remote reply is stored.
- **API token verifier hardening**: Gateway API tokens now use salted scrypt
  verifiers and CodeQL-clean validation paths instead of raw token hashes.
- **App view token scope**: Console app-view tokens are scoped to the app route
  they authorize, reducing token reuse across unrelated app views.

## [0.27.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.27.2) - 2026-07-06

### Fixed

- **Console PDF previews**: Console pages now allow `blob:` iframe sources in
  the defensive Content Security Policy, so browser-backed PDF previews render
  instead of being blocked by the `default-src 'self'` fallback. Gateway HTTP
  server tests cover the `frame-src 'self' blob:` directive.

## [0.27.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.27.1) - 2026-07-06

### Added

- **Onboarding audit trail**: First-run `BOOTSTRAP.md` hatching now records
  structured onboarding events for start/continue, quick prelude messages,
  user replies, assistant messages, welcome mail, workspace file updates,
  completion, and abort paths. The admin audit view recognizes `onboarding`
  as a first-class event category so operators can search and filter the
  hatching lifecycle directly.
- **Agent email e2e coverage**: Added an end-to-end agent email flow test and
  expanded focused coverage around onboarding audits, chat activity traces,
  tool progress parsing, mailbox polling, bootstrap autostart, and workspace
  bootstrap behavior.

### Changed

- **Tool progress retention**: Container tool progress now preserves complete
  progress output for chat activity traces while masking and capping retained
  log previews so long or sensitive tool progress does not overwhelm the UI or
  audit-adjacent surfaces.

### Fixed

- **Chat activity drafts**: Web chat preserves interim assistant drafts and
  tool-turn activity while a run is active, renders live drafts without answer
  bubbles, suppresses tool-call-only prose traces, collapses completed tool
  turns into the activity trace, and keeps non-final assistant drafts out of
  persisted chat history.
- **Email mailbox polling**: Mailbox status is refreshed before polling and
  idle email searches are skipped, avoiding stale UID state and unnecessary
  search work when there is no new mailbox activity.
- **Onboarding completion audits**: Hatching completion now survives agent
  cleanup, terminal audit records are preserved on error paths, onboarding mail
  and file-update events are captured, and lifecycle events are ordered so the
  audit trail reads from start through completion or abort.

## [0.27.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.27.0) - 2026-07-05

### Added

- **Chat activity traces**: The web `/chat` view now renders the agent's
  thinking and tool calls as a light-grey, collapsible trace above each answer.
  The trace streams live while the run is in flight (one row per thinking
  segment or tool call, with args/result previews and durations) and
  auto-collapses to a one-line summary once the final answer, an approval, or
  an error arrives. It consumes the `thinking` and `tool` NDJSON events the
  gateway already emits on `/api/chat`, gated by the session `/show` mode.
  The ordered trace is persisted per assistant message (schema v46), so a page
  reload replays the same activity instead of dropping it.
- **Apps gallery**: Web chat includes an `/apps` gallery and `/app <description>`
  flow for building self-contained HTML apps, documents, games, dashboards, and
  tools, then saving captured HTML artifacts with search, category filtering,
  previews, new-tab links, and deletion controls.
- **Live apps**: Apps can be marked as connector-aware live apps that embed a
  snapshot fallback and refresh inside the Apps viewer through a sandbox bridge
  for read-only MCP connector tool calls.

### Fixed

- **OpenAI Codex stream stalls**: Codex SSE reads now use an idle timeout so a
  stalled upstream stream is cancelled and surfaced as a retryable error instead
  of hanging indefinitely.

## [0.26.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.26.0) - 2026-07-03

### Added

- **Admin connector setup**: `/admin/connectors` can connect HybridAI with an
  API key, run Google Workspace OAuth from the browser, show connector
  connection state, test connector health, and launch HybridAI-managed GitHub
  and Microsoft 365 authorization flows.
- **HybridAI connector MCP**: Gateways with HybridAI credentials now
  auto-register the HybridAI connector MCP server unless an operator disables
  or overrides the `hybridai` MCP server entry.
- **Live email mailbox reads**: The `message` tool can search and read
  configured email mailboxes directly, with folder, unread, sender, subject,
  date, query, and UID filters plus thread snapshots for individual messages.
- **Microsoft 365 Graph skill**: Added a read-only `microsoft-365` skill for
  Outlook mail, calendars, OneDrive/SharePoint files, Teams, chats, and profile
  reads through Microsoft Graph, plus `hybridclaw auth login microsoft365` and
  `microsoft-oauth` secret routes for gateway-injected Graph access tokens.
- **Miro skill**: Added the `miro` skill for board discovery, metadata and item
  reads, guarded sticky/text/shape/connector/frame writes, OAuth token
  exchange helpers, and Enterprise board export workflows.
- **Zoho MCP skill**: Added the `zoho` skill for Zoho CRM, Desk, Mail,
  Calendar, Books, Projects, WorkDrive, Cliq, Campaigns, and related workflows
  through a configured Zoho MCP server.
- **A2A trust ledger**: A2A JSON-RPC and webhook trust now share a durable
  trusted-peer ledger with legacy migration, TOFU audit lineage, revocation
  state, and sender/public-key lookup paths.
- **A2A delegation trust pairing**: Agent Cards can advertise delegation
  signing keys and canonical sender ids, and pairing approval records the
  advertised A2A senders for trusted outbound delegation.
- **Console navigation config**: The top navigation strip can be customized
  from runtime config with local console paths or HTTP(S) URLs and link text.
- **Lexware quotations**: The `lexware-office` skill now covers quotation
  listing, retrieval, creation, and PDF downloads with explicit draft vs.
  finalized document guidance.

### Changed

- **Skill credential guidance**: Bundled API-backed skills now point operators
  to browser admin secrets first, then `/secret set` from chat or TUI, with
  local `hybridclaw secret set` commands as the fallback path.
- **Admin console docs**: Public docs and examples cover the connector setup
  surface, Microsoft Graph OAuth routes, the updated bundled-skill count, and
  the new Microsoft 365, Miro, Zoho, and live email mailbox-read surfaces.

### Fixed

- **Dependency security updates**: Resolved high npm audit findings, refreshed
  lockfiles and shrinkwrap files, and updated dependency policy baselines.
- **Connector auth hardening**: Connector flows isolate signed-payload secrets,
  keep return URLs result-neutral, restrict TLS pin secret resolution, and avoid
  connector taint paths flagged by CodeQL.
- **Vision artifact URLs**: `vision_analyze` accepts local
  `/api/artifact?path=...` URLs copied from chat history and resolves them to
  the underlying workspace or media-cache file.
- **Instruction restore prompt**: The TUI config restore prompt more clearly
  distinguishes restoring the last known-good config from manually repairing an
  invalid config file.

## [0.25.8](https://github.com/HybridAIOne/hybridclaw/tree/v0.25.8) - 2026-06-27

### Changed

- **Email admin layout**: Email channel advanced settings now collapse by
  default above additional mailboxes, keeping default allowlist management
  prominent while poll interval, chunk limit, media limit, and channel
  instructions remain available on demand.

### Fixed

- **Cloud MCP OAuth callbacks**: MCP OAuth setup now prefers the configured
  deployment public URL and other public gateway origins over private internal
  request hosts, rejects invalid configured public URLs, and covers IPv4, IPv6,
  and local development fallback cases.
- **Cloud request origins**: Admin session-cookie origin checks and mobile chat
  QR launch links now honor `deployment.public_url` when requests arrive through
  internal gateway hosts.
- **Email allowlist autosave**: Adding a default allowed sender in the admin
  console now saves immediately instead of leaving the new entry only in the
  unsaved draft state.

## [0.25.7](https://github.com/HybridAIOne/hybridclaw/tree/v0.25.7) - 2026-06-25

### Added

- **Admin sender allowlists**: Channel settings in the admin console can edit
  allowed sender lists for WhatsApp, Telegram, Threema, Signal, email
  (including mailbox-level allowlists), Microsoft Teams, Slack, and iMessage,
  with wildcard confirmation and explicit all-senders labeling.

### Changed

- **Hatching first run**: Fresh agents start with a shorter, conversational
  setup message that asks two or three natural questions, captures the user's
  email for the welcome note, and keeps model-generated hatching preludes
  limited to `BOOTSTRAP.md` sessions.
- **Session timestamps**: Gateway status and session displays render timestamps
  in the local timezone without noisy seconds or UTC suffixes.

### Fixed

- **Web chat drafts**: Starting a new conversation keeps the newly created
  no-user session selected and deletes older empty or assistant-only web chat
  drafts without touching sessions that already have user messages or scheduler
  sessions.
- **Bootstrap autostart reliability**: Hatching and `OPENING.md` autostarts no
  longer refresh already-started sessions on history probes, avoid duplicate
  concurrent runs, fall back cleanly when auxiliary prelude generation fails,
  and keep selected-agent autostart concrete.
- **Resource hygiene cleanup**: Doctor resource hygiene now labels stale no-user
  histories as unstarted sessions and cleans up empty or assistant-only rows
  while preserving sessions with user messages.

## [0.25.6](https://github.com/HybridAIOne/hybridclaw/tree/v0.25.6) - 2026-06-24

### Added

- **Launch-agent chat sessions**: `/chat?agent=<id>` links now mint a web chat
  session, preselect the requested local agent, and pass that agent through the
  history bootstrap path so the correct agent autostart runs for the new
  session.

### Fixed

- **Foreground gateway logging**: `gateway start --foreground` restores
  mirroring to the gateway log file even when the logger initializes before the
  foreground command configures the log path, while avoiding duplicate file
  streams when stdio is already redirected to the gateway log.

## [0.25.5](https://github.com/HybridAIOne/hybridclaw/tree/v0.25.5) - 2026-06-22

### Fixed

- **Remote agent mentions**: Selecting a remote agent in chat now places the
  caret after the inserted address and keeps the styled composer overlay caret
  aligned with the real textarea selection.
- **Streaming text deltas**: Container streaming now emits visible model text
  deltas live instead of buffering answer text until the model turn completes.
- **Host bootstrap cleanup**: Host-mode approval policy now recognizes the
  actual workspace-root `BOOTSTRAP.md` path as one-time onboarding cleanup while
  keeping nested or rootless delete calls approval-gated.

## [0.25.4](https://github.com/HybridAIOne/hybridclaw/tree/v0.25.4) - 2026-06-22

### Added

- **Remote agents in chat**: Trusted A2A peer agents now appear in the chat
  agent selector, grouped by remote instance. Selecting a remote agent inserts
  its canonical address and sends the message through the A2A delivery path.
- **Admin tunnel controls**: The admin dashboard now exposes public tunnel
  configuration, current tunnel health, and managed tunnel start, reconnect,
  and stop actions with validation, pending states, errors, and audit events.

### Changed

- **Console loading state**: Replaced the initial auth-check card with a
  branded, accessible HybridClaw loading screen and reduced-motion-aware
  progress treatment.

### Fixed

- **Console browser titles**: Chat and Agents routes now receive route-specific
  page titles from both the gateway-served HTML and client-side navigation,
  instead of showing the admin title outside admin pages.
- **Remote A2A delivery**: Queued remote A2A envelopes are canonicalized before
  persistence and audit recording so sender and recipient ids stay normalized.
- **Remote selector and tunnel polish**: Remote agent groups use a server icon,
  admin tunnel action buttons align and reflect start, stop, and reconnect
  states consistently, and revision tokens for config/team changes are opaque.

## [0.25.3](https://github.com/HybridAIOne/hybridclaw/tree/v0.25.3) - 2026-06-22

### Added

- **Langfuse skill**: LLM observability and evaluation based on the official
  Langfuse skill (`github.com/langfuse/skills`, MIT). Reads traces, observations,
  sessions, scores, prompts, datasets, models, and metrics, and creates scores,
  comments, datasets, dataset items, and prompt versions through the
  gateway-proxied `langfuse.cjs` helper. Auth uses a SecretRef-backed
  `Authorization: Basic <secret:LANGFUSE_BASIC_AUTH>` header with a
  `LANGFUSE_HOST` config variable; reads are green and writes are grant-gated.
  Bundles the upstream reference docs (instrumentation, prompt migration, error
  analysis, judge calibration, SDK upgrade, CI/CD) plus Langfuse documentation
  lookup (llms.txt / markdown / search-docs).

### Changed

- **Quick Start guide**: Rewrote the getting-started quickstart into a
  zero-to-working funnel -- a fast HybridAI Cloud path (model preselected,
  already in web chat) and a numbered local path (onboard -> start gateway ->
  confirm healthy with `gateway status` / `doctor` -> open chat -> send a first
  message) with explicit success signals, a troubleshooting block, and a command
  cheat sheet. Relocated the per-channel startup auto-connect conditions into the
  Channels overview.
- **Apple desktop diagnostics**: The desktop wrapper captures gateway startup
  logs, recent child output, spawn failures, and early exits so packaged app
  launch failures are diagnosable.
- **Dependency maintenance**: Remediated npm audit dependencies, upgraded
  Nodemailer to 9.0.0, refreshed dependency policy baselines, and clarified the
  dependency lockfile update workflow for future maintenance.

### Fixed

- **A2A Agent Card public URL**: The A2A Agent Card advertises the configured
  public deployment URL when present, and invalid `deployment.public_url` values
  fail closed instead of falling back to an internal request origin.
- **MCP server startup isolation**: A single MCP server that fails to connect or
  disconnect is logged and skipped instead of aborting the whole chat turn, and
  unchanged failed server configs are not retried every turn.
- **Empty heartbeat context**: Workspace bootstrap context skips the default
  empty `HEARTBEAT.md` template and legacy "no recurring heartbeat tasks"
  placeholders, avoiding noise in agent startup context.

## [0.25.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.25.2) - 2026-06-20

### Fixed

- **Cloud chat write authentication**: Cookie-authenticated browser writes now
  accept browser-confirmed same-origin fetch metadata, restoring cloud chat
  prompts, slash commands, agent changes, and model changes behind the
  TLS-terminating proxy.

## [0.25.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.25.1) - 2026-06-20

### Changed

- **Desktop packaging**: Desktop build commands rebuild the app before
  packaging, reuse current icon/runtime stages, cache the staged Node runtime,
  and strip non-runtime dependency files from packaged desktop bundles.

### Fixed

- **HybridAI cloud admin sessions**: HybridAI-launched sessions without scoped
  RBAC claims are treated as full admin sessions for compatibility, explicit
  scoped sessions remain restricted, and cookie-authenticated admin mutations
  respect forwarded public origins behind the cloud proxy.

## [0.25.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.25.0) - 2026-06-20

### Added

- **Improved onboarding experience**: First-run hatching has a dedicated
  `hybridai.onboardingModel` override, runtime-aware bootstrap context,
  stronger welcome-email guidance, preserved setup links in chat, direct
  Markdown links for local setup routes, completion tracking after the first
  email, and duplicate-autostart protection. New agents receive the bootstrap
  file at creation time, reinstalled agents can hatch again when appropriate,
  and completed agents can show tailored empty-chat headers without restarting
  onboarding.
- **Remote MCP OAuth**: Remote `http` and `sse` MCP servers can opt into
  `"auth": "oauth"` with gateway-managed OAuth 2.1 discovery, PKCE, dynamic
  client registration, encrypted token storage, automatic refresh, and guided
  setup in both the TUI and admin console. Added `/mcp login`, `/mcp logout`,
  and `/mcp status` flows for local and chat channels.
- **Admin skill detail pages**: `/admin/skills` now opens dedicated detail
  pages with parsed docs, tool/prompt/dependency metadata, package logos,
  credential status, write-only secret management, enable/disable controls,
  example prompt launchers, recent invocations, and guarded text-file editing
  for installed skill packages.
- **Per-agent email mailboxes**: Built-in IMAP/SMTP email supports
  `email.accounts[]` so separate mailbox credentials can route inbound mail to
  specific agents, send replies from the mailbox that received the thread, and
  prefer the active agent's mailbox for agent-initiated sends.
- **Agent-risk eval harness**: Added `/eval agent-risk` and
  `hybridclaw eval agent-risk` with synthetic canary scenarios covering every
  top-level NIST AI RMF function, NIST AI 600-1 GAI risk, and OWASP LLM Top 10
  2025 item. The gate writes redacted evidence artifacts and supports focused
  scenario runs.
- **Admin access control evidence**: Added scoped admin RBAC role bundles,
  route-level action enforcement for scoped sessions, terminal stream
  authorization checks, admin access-control docs, and ISO/IEC 27001 evidence
  records for access review, control ownership, monitoring, suppliers, risk,
  asset/data inventory, signoff, and evidence cadence.
- **ISO/IEC 42001 readiness docs**: Added an AI management-system readiness
  matrix and reusable evidence templates for HybridClaw AI subsystem inventory,
  risk, impact, lifecycle, monitoring, and human oversight records.
- **PostHog business skill**: Added a bundled `posthog` skill for guarded
  event capture, person-property updates, private person reads, feature flag
  reads and test evaluation, Query API/HogQL reads, approval plans, and
  missing-secret diagnostics through the gateway HTTP proxy.
- **Guarded session pruning**: Added `sessions prune --older-than <duration>`
  with dry-run default, explicit `--confirm`, protected-session skips, minimum
  retention, and structured `session.prune` audit events.
- **Supply-chain security workflow**: Added BuildKit provenance and SBOM
  attestations for Docker builds, a pinned Security Scan workflow with CodeQL
  and tracked secret scanning, and `npm run security:secret-scan` for local
  verification.

### Changed

- **Agent package installs**: `.claw` installs restore only archived workspace
  files plus manifest-declared bundled/imported assets. Default bootstrap
  templates are seeded by agent creation, not by package install, preserving
  the package author's exact workspace file set.
- **Admin browser auth**: Browser admin auth uses signed HttpOnly session
  cookies for callback flows, keeps manual fallback tokens tab-scoped, removes
  EventSource query-token auth, and keeps broad bearer-token API compatibility
  for existing operators.
- **MCP and docs navigation**: Docs navigation now comes from a shared
  `docs/content/navigation.json` manifest used by the static docs app and
  gateway docs renderer, keeping internal docs direct-linkable but absent from
  sidebar and search unless explicitly listed.
- **HybridAI request identity**: Gateway, container, and eval HybridAI calls
  include a versioned `hybridclaw/<version>` user agent for upstream
  diagnostics.
- **Homepage and docs positioning**: The homepage, docs shell, setup docs, and
  release facts were refreshed around current managed-cloud, distillation,
  A2A, proxy-agent, channel, business-skill, admin, and security capabilities.

### Fixed

- **Hatching and opening-message reliability**: Bootstrap autostarts use an
  atomic cross-process claim, GPT-5-family hatching is guided to send the
  welcome email once required user details are present, duplicated bootstrap
  blocks are collapsed, `OPENING.md` autostart produces one assistant message,
  and setup links remain visible in chat after the welcome email.
- **HybridAI onboarding bot fallback**: Agent/model controls stay in sync after
  `/agent switch`, `/bot clear` clears both session and configured default bot
  state, and HybridAI default-user fallback can resolve the user's bot without
  stale default-chatbot reuse.
- **Mobile chat QR handoff**: QR continuation tokens preserve web-session auth
  and set the signed session cookie before redirecting to the target chat, so
  cloud/container deployments open the intended session instead of bouncing to
  login.
- **Named local model selection**: The model switcher shows local route labels
  in row subtitles and search text, so duplicate-looking entries such as
  default `vLLM` and named `haigpu1` Qwen routes are distinguishable.
- **Skill admin polish**: Skill detail navigation stays inside the admin app,
  skill-only slash commands link back to detail pages, package assets are not
  surfaced as generic chat artifacts, credential overwrite labels are clearer,
  set credentials show checkmarks, and Blink uses the official logo asset.
- **Secret-scan eval fixtures**: Agent-risk eval canaries were renamed to avoid
  secret-shaped false positives while preserving the intended leakage tests.

## [0.24.4](https://github.com/HybridAIOne/hybridclaw/tree/v0.24.4) - 2026-06-16

### Added

- **Admin logging modes**: The admin Logs page can switch logging Off, On, or
  Debug from the console, persist the runtime config, reload the gateway, and
  keep selected log tails pinned to the newest content after load or refresh.

### Changed

- **Admin Logs readability**: The Logs page gives the detail panel more room,
  avoids duplicate path display, keeps the selected path visible in metadata,
  strips ANSI color from tails, aligns mid-file tails, and shows full local
  dates in formatted timestamps.
- **Runtime logging config**: Request logging and model-response debug capture
  are controlled through `ops.logRequests` and `ops.debugModelResponses` while
  preserving environment and CLI startup overrides.

### Fixed

- **Admin dropdown selection**: Controlled native selects now apply the first
  chosen option immediately by marking fields touched through React
  change/blur handling instead of wrapper-level native listeners.
- **GPT-5 onboarding email send**: GPT-5-family hatching prompts now tell the
  agent to send the welcome message once basic user info and a valid email
  address are present, without showing a draft or asking for another
  confirmation.
- **Logging mode save feedback**: The Logs page checks gateway reload
  responses before reporting logging mode updates as saved and refreshes the
  effective runtime state after save.

## [0.24.3](https://github.com/HybridAIOne/hybridclaw/tree/v0.24.3) - 2026-06-15

### Changed

- **Hatching conversation flow**: Agent hatching now stays conversational and
  uses a tailored first-email subject instead of a fixed default. Web chat
  reflects gateway-owned hatching autostart with a thinking state and refreshed
  history instead of injecting a hidden kickoff message from the browser.

### Fixed

- **Confidential audit metadata**: Confidential masking and rehydration now
  write metadata-only audit events with redaction counts, class summaries, and
  surface names while keeping raw secret and client values out of the audit
  wire log.
- **Codex model discovery recovery**: Codex model discovery force-refreshes
  stale credentials after authorization failures, can re-import the Codex CLI
  auth store when refresh requires relogin, and avoids caching empty model
  lists after rejected credentials.
- **Hatching chat continuity**: Switched-agent hatching turns now keep the full
  prior chat history in context, avoid repeating onboarding after the prelude,
  and reload browser history so gateway-authored hatching messages appear
  immediately.
- **Legacy audit user actors**: Structured audit queries canonicalize legacy
  plain user ids as local user actors and validate the normalized actor before
  indexing.
- **Container edit compatibility**: The container `edit` tool accepts
  model-generated `old_text` and `new_text` aliases in addition to the primary
  replacement fields.

## [0.24.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.24.2) - 2026-06-14

### Added

- **Admin log viewer**: The admin console includes a Logs route and sidebar
  entry for inspecting configured gateway and model-response debug log tails.
  Operators can see file status, size, modified time, and capped tail content
  through the gateway API without shelling into the host.

### Changed

- **Desktop macOS packaging**: Desktop DMG builds use
  `electron-builder --mac dir zip dmg` end to end, removing the custom
  `appdmg` path and scripts. The desktop release guide documents the expected
  app, ZIP, block map, and DMG outputs, and the dependency-policy baseline is
  aligned with the Electron packaging lockfile.

### Fixed

- **WhatsApp auth lock recovery**: Stale WhatsApp auth locks from a previous
  process lifetime with the same PID are cleared before acquiring a fresh
  lock, preventing reconnect, linking, or reset flows from blocking on
  orphaned lock metadata.

## [0.24.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.24.1) - 2026-06-14

### Added

- **Onboarding helpful links**: New agent workspaces seed a `Helpful Links`
  section in `USER.md` for agent chat, WhatsApp setup, and documentation URLs.
  The hatching flow now reads those exact links when preparing the tailored
  first-jobs email and includes whichever links are available instead of
  guessing deployment URLs. The admin Channels page also honors `#whatsapp`
  deep links by selecting and scrolling directly to the WhatsApp setup panel.

### Fixed

- **WhatsApp pairing diagnostics**: WhatsApp transport, reconnect, and pairing
  failures are now stored in pairing status and surfaced in the admin Channels
  UI instead of leaving operators on a generic "waiting for QR" message.
- **Bootstrap cleanup approvals**: Deleting the root `BOOTSTRAP.md` one-time
  onboarding file is now auto-approved as safe cleanup after hatching, while
  other delete calls still require explicit approval.
- **HybridAI empty completion recovery**: HybridAI responses with no visible
  text and no tool call now get one targeted retry before the container fails
  the turn. Whitespace-only content is treated as empty, and the stalled-turn
  budget tracks the retry.
- **WebSocket transport error handling**: Expected transport failures nested in
  wrapper `data`, `error`, `cause`, or aggregate fields are classified
  consistently, timeout messages are rendered clearly, expected handshake
  timeouts are dropped before Sentry reporting, and WhatsApp reconnect handling
  preserves the original disconnect error for diagnosis.

## [0.24.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.24.0) - 2026-06-11

### Added

- **Human distillation (R72)**: New `hybridclaw coworker` command group and
  bundled `human-distill` skill that distills a real person's source material
  into a coworker agent. Collectors normalise Slack exports, mbox email,
  meeting transcripts, chat JSONL, documents, and gap-driven interview
  questionnaires into an agent-scoped corpus with quality weighting, stable
  provenance ids, and third-party PII masking at ingest. A resumable
  ingest → analyse → build → merge → correct pipeline writes the persona into
  the standard identity files (`IDENTITY.md`, `SOUL.md`, `USER.md`, `CV.md`)
  and a generated work-module skill, with `/admin/distill` managing subjects,
  consent, source uploads, corpus documents, and runs from the browser. Every
  claim cites corpus documents (uncited claims are flagged, not written),
  every merge is an F4-versioned reversible edit, and conflicting evidence is
  surfaced as operator review items. Distilling a real, named human is
  hard-blocked until a consent artefact is recorded; all lifecycle actions
  emit hash-chained `distill.*` audit events; `coworker forget` erases corpus,
  persona, work module, runs, and revision snapshots as one identifier set.
  Includes a leakage/fidelity eval (`coworker eval`), conversational
  corrections (`coworker correct`), and one-bundle multi-host export/install
  for Claude Code, Codex, OpenClaw, and HybridClaw.
- **Cloud memory sync**: Agents now sync local memory files (`MEMORY.md`,
  `USER.md`, and recent daily memory notes) with the HybridAI cloud and receive
  shared installation- and company-scoped memory back for prompt context. Sync
  runs at conversation start and periodically every five minutes with
  per-agent rate limiting, requires `HYBRIDAI_API_KEY`, `HYBRIDAI_BASE_URL`
  (HTTPS only), and `HYBRIDAI_CHATBOT_ID`, and stays disabled when those are
  unset. Shared memory appears read-only in the agent file editor under a
  "Shared memory" group.
- **A2A operator pairing**: Added `/admin/a2a-trust` for pairing two HybridClaw
  instances: operators fetch a peer Agent Card by URL or canonical DNS
  identifier, preview its identity and key fingerprint, and trust it with an
  optional peer-side approval prompt. Incoming pairing requests arrive through
  a rate-limited `/a2a/pairing/requests` endpoint and can be approved or
  declined from the console with audit-trail decision reasons.
- **Inbound A2A envelopes**: Added a JSON-RPC Agent Card envelope receiver for
  cross-instance A2A delivery, including canonical sender/recipient metadata,
  idempotent persistence, signed bearer-token validation, read-only admin
  inbox visibility, and audit events for malformed or rejected envelopes.
- **HybridAI proxy agents**: Agents can now proxy conversations to hosted
  HybridAI chatbots via per-agent `proxy` config, SecretRef-backed API keys,
  HTTPS-only upstreams, selectable channel- or user-scoped conversation ids,
  streaming response forwarding, and `/status` visibility for proxy mode.
- **Explicit agent addressing**: Chat channels and web chat can address
  specific agents inline, with mention autocomplete, avatar-backed mention
  pills, canonical recipient handling, and fanout hardening for local
  proactive delivery.
- **`byd-battery` skill**: Added read-only monitoring for BYD Battery-Box
  Premium HVS/HVM/LVS/LVL home-storage systems over local Modbus TCP or
  Fronius inverter delegation, covering state of charge, pack telemetry, cell
  extremes, tower/module inventory, decoded alarms, firmware info, and energy
  counters, with allowlisted register ranges and no write operations.
- **`mailchimp` skill**: Added Mailchimp Marketing and Mailchimp
  Transactional/Mandrill workflows for credential checks, audience/member
  reads, guarded subscriber and tag mutations, campaign draft/content/report
  operations, automations, journeys, and approval-gated campaign or
  transactional sends through the gateway HTTP proxy.
- **Amber approval cards**: Web chat approval prompts now render as structured
  confirmation cards with an approval-tier badge, parsed action/tool/reason
  detail rows, and separated confirm/deny and trust-scope button groups.
- **Named local model endpoints**: Local provider config now supports
  additional named Ollama, LM Studio, llama.cpp, and vLLM endpoints with
  endpoint-prefixed model ids, CLI setup via `--name`, and per-endpoint model
  behavior flags for Qwen thinking markup and Gemma tool-call formats.
- **Auxiliary model testing**: Added `/aux test <task> <prompt>` so operators
  can exercise configured auxiliary model routes directly and see the
  provider/model used for the request.
- **Response rating forwarding**: Thumbs up/down ratings on web chat responses
  are forwarded to the HybridAI feedback API when HybridAI authentication is
  active, alongside the existing local rating store and audit events.
  Forwarding is non-blocking and skips silently when auth is unavailable.

### Changed

- **README and skill docs positioning**: The public README and skills docs now
  lead with HybridClaw's validated business-skill workflow: helper-backed
  production skills, eval scenarios, approval tiers, credential boundaries, and
  `Qwen/Qwen3.6-27B-FP8` as the small-model validation baseline.
- **Multi-agent and credential-isolation positioning**: The README and docs
  now call out multi-instance A2A workflows, hosted proxy agents, explicit
  addressing, and SecretRef-backed execution that keeps raw credentials out of
  model context.
- **HybridAI Cloud launch path**: The README, docs landing page, and
  installation guide now link to the managed HybridClaw cloud offering at
  `hybridclaw.io`.
- **Desktop release order docs**: The macOS desktop release guide now
  recommends building and notarizing from the exact version tag, uploading
  desktop assets to a draft GitHub Release, then publishing after assets are
  verified.
- **Provider request payloads**: Empty tool definitions are omitted from
  HybridAI, OpenAI-compatible, Codex, and Ollama provider requests instead of
  sending empty `tools` arrays.
- **Local vLLM tool behavior**: OpenAI-compatible local providers infer and
  remember native-tool fallback support, count prompt-side tool overhead in
  context guards, refresh named-endpoint metadata, and parse Gemma text tool
  calls emitted before or after Markdown wrappers.
- **Structured actors in audit data**: Audit/event records now carry unified
  actor identities across A2A envelopes, board cards, adaptive-skill
  observations, scoreboards, and structured audit queries.
- **Coworker liveness scan**: Skill scans during coworker liveness checks use
  set-based agent filtering, speeding up gateways with many agents.
- **Release version sync tooling**: `npm run version:sync` now keeps root,
  console, desktop, container, lockfile, and shrinkwrap package versions in
  sync, with `release:check` validating the same invariant.
- **Dependency updates**: Routine minor and patch dependency updates across the
  gateway, console, container, and desktop packages, plus overrides that lift
  transitive `shell-quote` and `tmp` to patched releases flagged by npm audit.

### Fixed

- **Gateway token timing safety**: Gateway API and bearer token checks use
  constant-time comparison to avoid timing side channels.
- **Delegation identifiers**: Delegation session and batch job identifiers use
  cryptographic UUIDs instead of seeded pseudo-random strings.
- **Containment check stalls**: Media and artifact path containment checks
  resolve real paths asynchronously so large directory validation no longer
  blocks the gateway event loop.
- **TUI ANSI truncation**: Terminal output truncation handles incomplete ANSI
  escape sequences and wide glyphs without corrupting styled text.
- **Duplicate hatching after onboarding**: Switching agents after onboarding
  no longer re-triggers the workspace bootstrap kickoff, and bootstrap job
  detection recognizes both bulleted and numbered job lists.
- **Host runtime dependency detection**: Source-checkout host runtime checks
  no longer misreport container dependencies as missing when npm hoists a
  package whose `exports` map does not expose `package.json` (e.g.
  `dompurify`).
- **Installer and setup hardening**: The one-line installer, postinstall
  container setup, Node version guard, and Homebrew/source-checkout paths handle
  no-sudo installs, user npm prefixes, and container dependency setup more
  reliably.

## [0.23.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.23.0) - 2026-06-09

### Added

- **`blink` skill**: Added Blink camera and video-doorbell workflows for
  OAuth v2 login with PIN handoff, device/network/camera inventory, motion
  clip listing and artifact-backed downloads, guarded arm/disarm and motion
  control plans, and fresh-thumbnail refresh handling that keeps Blink media
  bytes out of model context.
- **`hue` skill**: Added Philips Hue Bridge support for local CLIP v2 reads,
  bridge-link credential capture, self-signed bridge TLS handling, guarded
  light/group/scene/behavior changes, Remote API token refresh support, and
  LAN policy diagnostics for Hue Bridge requests.
- **Fleet topology admin UI**: Added `/admin/fleet-topology` for viewing the
  local A2A instance identity, checking trusted child instances through their
  Agent Card URLs, and adding, editing, or removing A2A trust-ledger peers from
  the console.
- **Admin secrets console**: Added `/admin/secrets` as a write-only secret
  manager that lists set and declared-but-empty secrets by metadata, supports
  overwrite and unset actions, and never returns cleartext secret values to the
  browser.
- **Chat code rendering**: Web chat now syntax-highlights completed code
  blocks, shows language labels, and provides a touch-reachable copy button
  with success feedback while skipping highlighter work for actively streaming
  messages.
- **Sentry error reporting**: `hybridclaw env set SENTRY_DSN <dsn>` enables
  optional gateway Sentry reporting for startup failures, uncaught exceptions,
  unhandled rejections, and errors recorded through shared gateway/agent spans,
  with default `production` environment, automatic
  `hybridclaw@<package-version>` release naming, secret redaction, and graceful
  shutdown flushes.
- **Scheduler heartbeat polling action**: Config-backed scheduler jobs can use
  the explicit `heartbeat_poll` action kind so empty `HEARTBEAT.md` files are
  skipped before any model turn is started.

### Changed

- **Installer and npm policy alignment**: The bootstrap installer works more
  cleanly on fresh Debian/Ubuntu hosts and no-sudo system Node setups, while
  contributor docs, CI, Docker, and package metadata pin npm 11.10+ without
  forcing consumer-facing `engines.npm` warnings.
- **Second-opinion TUI formatting**: `/second-opinion` output in the terminal
  wraps long model-comparison and validation responses instead of spilling past
  the viewport.
- **Skill setup guidance**: Skill authoring docs now require chat-friendly
  `/env` and `/secret` setup alternatives alongside local `hybridclaw env` and
  `hybridclaw secret` commands.
- **Web agent hatching kickoff**: Switching to an agent with an active
  `BOOTSTRAP.md` in web chat now sends a hidden kickoff turn so hatching starts
  immediately while the visible slash-command response remains local command
  output.

### Fixed

- **Interrupted agent shutdown output**: Container/runtime shutdown output now
  distinguishes expected interrupted-run signal errors from real runtime
  failures.
- **Slash autocomplete flags**: TUI slash-command autocomplete keeps literal
  argument and flag completions instead of rewriting them.
- **Chat delete guard**: Deleting browser chat sessions is blocked while a run
  is still active for that session.
- **Malformed Unicode in prompts**: Container utilities sanitize malformed
  Unicode so provider prompts and local OpenAI-compatible requests do not fail
  on invalid surrogate data.
- **Trace export identity preservation**: Session trace exports preserve trace
  hash identifiers while applying secret redaction.
- **Web approval buttons**: Approval buttons now emit gateway-supported
  commands: `Allow once` sends `/approve yes`, `Allow always` sends
  `/approve all`, and scoped buttons send their matching `session` or `agent`
  approvals.

## [0.22.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.22.0) - 2026-06-05

### Added

- **One-line installer**: Added `scripts/install.sh` for Linux/macOS bootstrap
  installs that ensure Node.js 22, install the global CLI, check Docker, and
  optionally run onboarding without requiring `sudo`. Installation docs now
  cover dry-run, pinned-version, no-prompt, verification, WSL2, and Alpine
  usage.
- **Interactive startup update prompt**: Starting HybridClaw on a terminal
  (`hybridclaw tui`, `hybridclaw gateway`, or `hybridclaw gateway start`) now
  checks for a newer published release and offers a yes/no prompt to update
  before continuing. Skipped for non-interactive shells and source checkouts.
- **`alexa` skill**: Added Alexa Skills Kit request verification, TTS-safe
  response building, account-link session exchange, guarded Smart Home API
  plans, and opt-in Alexa Remote workflows for devices, lists, announcements,
  music playback, routines, and voice-command execution.
- **Gateway Docker startup recovery**: Interactive gateway and TUI startup can
  recover from missing Docker, unavailable Docker daemons, and Docker permission
  failures by retrying after the operator starts Docker or by continuing in
  host mode for the current run only.
- **Agent runtime setup progress**: Container image pull/build operations now
  show concise interactive progress for first-time setup, refreshes, and stale
  runtime updates, with a `HYBRIDCLAW_NO_SPINNER=1` fallback for plain output.

### Changed

- **Full audit trace tool results**: Tool execution audit events now retain
  redacted full result text for `/audit turn` and ATIF trace exports, with
  `audit.toolResults.mode` and `audit.toolResults.maxChars` config available
  when operators need truncation.
- **Node.js runtime guard**: CLI startup now fails fast on unsupported Node.js
  versions instead of allowing later dependency/runtime failures under an
  incompatible engine.
- **Test and CI wiring**: Docker-dependent e2e coverage is self-gating, while
  container startup recovery, Node version guards, update prompts, audit
  exports, and Alexa helpers gained targeted test coverage.

### Fixed

- **Provider onboarding secret exposure**: Provider API keys entered during
  onboarding are masked instead of echoed in terminal prompts or summaries.
- **WhatsApp config reloads**: Gateway config changes now restart the WhatsApp
  integration so pairing and policy updates take effect without a full gateway
  restart.
- **OpenAI Codex auth compatibility**: Codex device-code auth now sends the
  official `codex_cli_rs` originator and accepts responses that use `usercode`
  instead of `user_code`.
- **TypeScript plugin loading**: Runtime plugin loading handles `.ts` plugin
  entrypoints through `amaro` for Node.js 22.x compatibility.
- **Console theme initialization**: The admin console applies the configured
  theme on every route instead of only initializing it from the admin shell.
- **Scheduler noop TUI delivery**: Scheduled tasks that report heartbeat or
  idle/no-work results no longer create unnecessary proactive TUI deliveries.
- **Dependency audit advisories**: In-range and breaking dependency updates
  clear high-severity transitive advisories while keeping release signature
  audit baselines aligned.

## [0.21.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.21.1) - 2026-05-29

### Fixed

- **Codex device-code login**: Accepted OpenAI Codex device-code responses that
  return `usercode` instead of `user_code`, and defaulted missing verification
  URLs to the current Codex device login page.

## [0.21.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.21.0) - 2026-05-29

### Added

- **A2A cross-instance transport**: Outbound A2A delivery can resolve
  canonical peer IDs through the local deployment URL or active tunnel URL, the
  public-key trust ledger, and DNS-style discovery, then dispatch over the A2A
  transport with route invalidation and coverage for remote handoff delivery.
- **Harness evolution loop**: Added `hybridclaw harness-evolve` for
  eval-driven coworker workspace evolution, including seed validation,
  round/rollout summaries, F12 manifest reporting, allowed-surface write
  enforcement, and admin inspection support.
- **Second-opinion command**: Added `/second-opinion` for stronger-model
  comparison, validation of the last answer, and optional fact-checking with
  web-search evidence. The command refreshes the model catalog, estimates
  context/cost, honors per-agent budgets, and redacts or blocks confidential
  payloads before remote model calls.
- **Web response ratings**: Added thumbs-up/thumbs-down controls for persisted
  web chat assistant responses, backed by idempotent per-operator ratings,
  `response.rating` observability events, and Adaptive Skills feedback when a
  response maps to a skill observation.
- **Turn-level audit traces**: Added focused `/audit turn` and `/audit run`
  trace views plus session trace export support for inspecting the exact
  request, response, tool, approval, and audit events around one turn.
- **Token agent budgets**: Agent budget config now supports token caps in
  addition to USD/EUR spend caps, and board/job budget chips report token
  usage with neutral, warning, and over-budget states.
- **Per-channel brand-voice profiles**: The `output-guard` plugin can apply
  channel-specific brand-voice profiles, blocked terms, rewrite behavior, and
  guard configuration.
- **`homematic` skill**: Added Homematic IP Home Control Unit state reads,
  Connect API auth setup payloads, WebSocket message planning, guarded switch,
  thermostat, shutter, scene, and safety-alarm control plans, and offline HCU
  state fixture summaries.
- **`fronius` skill**: Added Fronius photovoltaic monitoring through local
  Fronius Solar API V1 and Solar.web Query API reads, including local health,
  live power flow, energy rollups, cloud system/device/status endpoints, and
  SecretRef-backed Solar.web access-key headers.

### Changed

- **Security fallback deprecations**: Added migration warnings for legacy
  BlueBubbles query-param webhook auth, unbound `bearerSecretName` and
  `secretHeaders` injection, and legacy `container.additionalMounts` config.
  Existing setups continue to work during the deprecation window while docs and
  `hybridclaw doctor security` point operators to header auth, bound bearer
  secrets, and `container.binds`.
- **A2A handoff ownership**: Handoff envelopes now preserve recipient
  ownership and org-chart context so inbox views, persisted threads, and audit
  records can distinguish handoff recipient responsibility from ordinary chat
  routing.
- **Slash-command rendering**: Web chat treats slash-command output as a
  distinct command-result block instead of rendering it as ordinary assistant
  prose, with stream metadata carried through history reloads.
- **Admin console dialog behavior**: Console sheets were consolidated into the
  dialog component, exit animation handling moved to the Web Animations API,
  and focus guards were tightened for modal navigation.
- **Console linting**: Added a console lint script and moved Biome scoping into
  the shared config so root and console checks use the same formatting source
  of truth.
- **Roadmap status**: Updated internal roadmap status for merged A2A,
  brand-voice, budget-chip, second-opinion, response-rating, harness
  evolution, Homematic, Fronius, and T Cloud Public work, and added follow-up
  rows for AWS, Blink, BYD Battery, Alexa, Hue, skill identity assets/chat
  rendering, and pluggable secret backends.

### Fixed

- **Unknown provider prefixes**: Provider factory validation now rejects
  unknown provider-prefixed model ids instead of falling through to an
  unintended provider.
- **Recovered skill tool failures**: Skill evaluations that recover from tool
  failures are classified as partial instead of successful, and the admin
  Skills page surfaces those partial states more clearly.
- **Idle heartbeat runs**: Heartbeat scheduling skips idle agent runs instead
  of creating empty proactive work.
- **Web chat newlines**: Assistant message rendering preserves newlines in web
  chat responses.
- **npm signature audit attestation 404s**: Treat missing npm registry
  attestation endpoint artifacts as best-effort after retries while keeping
  registry signature validation failures fatal.
- **Release workflow reruns**: Skip `npm publish` when the exact package
  version already exists on npm so release reruns can complete after partial
  publishes.

## [0.20.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.20.0) - 2026-05-26

### Added

- **Codex app-server runtime**: Added an optional `openai-codex/*` runtime
  path through `codex app-server`, including HybridClaw callback MCP tools,
  approval translation, transcript projection, and runtime-selector tests.
- **Managed and Mac browser providers**: Added managed-cloud browser launch,
  tenant navigation policy, provider health checks, and a macOS CUA browser
  provider with `hybridclaw doctor cua-mac` diagnostics.
- **Browser 2FA handoff**: Browser providers can detect two-factor and
  device-check waypoints, park the run for operator escalation, and resume
  without exposing credentials to the model.
- **Admin console surfaces**: Added Agents Overview, Output Guard, richer
  config editing, per-agent budget chips, job and chat UI improvements, and
  admin secret overwrite/unset APIs that never return cleartext values.
- **`hubspot` skill**: Adds HubSpot CRM reads and guarded writes for contacts,
  companies, deals, notes, and tasks through SecretRef-backed bearer auth.
- **`lexware-office` skill**: Adds Lexware Office contacts, invoices,
  vouchers, receipts, posting categories, and payment-state workflows through
  the Lexware Public API.
- **`hetzner-cloud` skill**: Adds Hetzner Cloud inventory, cost, provisioning,
  volume, snapshot, restore, and guarded delete workflows.
- **`hetzner-dns` skill**: Adds Hetzner DNS zone and record inspection plus
  guarded A, AAAA, CNAME, TXT, add, update, and delete workflows.
- **`hetzner-storage-box` skill**: Adds Hetzner Storage Box inventory,
  snapshot, WebDAV file, archive, upload, download, and public URL workflows.
- **`zabbix` skill**: Adds Zabbix monitoring reads for API health, host
  inventory, current problems, trigger severity summaries, and incident
  context.
- **`t-cloud-public` skill**: Adds T Cloud Public and Open Telekom Cloud
  infrastructure inventory, quotas, service status, and guarded operation
  planning with gateway-managed API signing.
- **`mittwald` skill**: Adds mittwald mStudio and Kundencenter reads for
  projects, apps, runtimes, databases, domains, mail, backups, files,
  containers, and access users.
- **`shelly` skill**: Adds Shelly local and cloud device inspection plus
  guarded relay, switch, light, and cover control workflows.
- **`fax-send` skill**: Adds outbound fax preparation and explicitly approved
  send workflows for configured fax providers.
- **`distil-pii-redactor` skill**: Adds local PII redaction and anonymization
  with Distil-PII and `llama.cpp` so sensitive text can be sanitized before it
  reaches external tools.
- **`warehouse-sql` skill**: Adds reviewed natural-language SQL workflows with
  cached schema inspection, model-review enforcement, and guarded execution
  for warehouse queries.
- **Fax channel docs and accounting**: Added outbound fax skill support,
  provider-facing fax accounting helpers, eval scenarios, and setup
  documentation for fax workflows.
- **Adaptive Skills SkillOpt-lite**: Added trajectory minibatch reflection,
  bounded edit candidates, candidate artifacts, held-out evaluation gates, and
  acceptance tests for the adaptive-skills amendment loop.
- **Board dependency edges**: Board cards can carry typed `blocks`,
  `blocked_by`, and `related` edges so work-board status and future
  coordination surfaces can reason about dependencies.
- **Supply-chain guardrails**: Added dependency-audit workflow coverage,
  shrinkwrap synchronization, release-check updates, and dependency policy
  baselines.
- **Google OAuth recovery hint**: Authentication diagnostics include an
  actionable recovery hint when Google OAuth state needs to be refreshed.

### Changed

- **Diagram validation and accounting**: Mermaid diagrams are validated with
  the bundled Mermaid parser before render, diagram render artifacts retain
  skill-scoped source/rendered metadata, and local diagram renders emit
  zero-cost usage hooks so budget accounting only reflects LLM token use.
- **Skill amendment safety**: Skill amendment generation and application now
  enforce tighter best-practice constraints, clearer formatting, and rollback
  evaluation behavior.
- **SkillOpt roadmap status**: Roadmap docs reflect the full SkillOpt-lite
  implementation status after the acceptance gates landed.
- **Auxiliary routing and provider health**: Auxiliary model calls prefer
  healthy local providers when configured and route through health-aware
  fallback decisions.
- **FastBill wrapper guidance**: FastBill API helper instructions and guard
  rails are stricter to reduce model-side request reconstruction mistakes.
- **Runtime and docs diagnostics**: Gateway status and operator docs describe
  the current runtime, managed-browser, threat-model, and skill setup surfaces
  more completely.
- **Conversation preview logging**: Web chat diagnostics label conversation
  preview roles more clearly.

### Fixed

- **Remote A2A routing bug**: Fixed `sendMessage` delivery for remote A2A
  recipients that were incorrectly treated as local recipients.
- **Skill CLI runtime bug**: Fixed skill CLI runtime initialization so skill
  commands start with the expected runtime context.
- **Targeted skill learning bug**: Fixed targeted skill learning so quiet
  learning paths do not emit unnecessary operator-facing output.
- **Admin SPA navigation bug**: Fixed admin job links that triggered full-page
  reloads instead of staying inside the existing SPA route.
- **Observability ingest token bug**: Fixed stale observability ingest tokens
  that could cause ingest requests to fail after token rotation.
- **Chat error banner bug**: Fixed web chat error banners that could remain
  visible after the underlying error state cleared.

## [0.19.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.19.2) - 2026-05-14

### Fixed

- **Diagram tool names**: Renamed the advertised diagram runtime tools to
  `diagram_create`, `diagram_update`, and `diagram_validate` everywhere so
  OpenAI-compatible providers accept the tool schema instead of rejecting
  dotted function names.

## [0.19.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.19.1) - 2026-05-14

### Fixed

- **Release npm signature verification**: The npm publish workflow now uses
  the repo's signature-audit wrapper so the temporary Baileys release-age
  bypass is applied consistently before publishing.

## [0.19.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.19.0) - 2026-05-14

### Added

- **Persistent standing goals**: Added `/goal` as a per-thread completion
  condition that persists across turns, queues supervised continuations until a
  judge marks the condition complete, reports goal status/counters, and pauses
  cleanly for approvals, user interruptions, malformed judge output, or
  explicit `pause`/`clear` commands. Goal continuations include the current
  goal step and use scoped TUI/proactive labels so they remain distinct from
  reminders and ordinary user turns.
- **Native speech-to-text transcription**: Added the `audio_transcribe` runtime
  tool plus bundled `speech.transcribe` and `speech.detect-language` skills for
  provider-agnostic transcription, language detection, diarization, timestamps,
  transcript artifact persistence, and usage-cost accounting across configured
  OpenAI, Deepgram, AssemblyAI, and local backends.
- **Discord Incoming Webhook channel**: Added outbound-only `discord_webhook`
  delivery for Discord webhook URLs, including default and named targets,
  encrypted SecretRef storage, CLI/Admin setup, message chunking, doctor/status
  visibility, and managed POST-only network policy grants.
- **Diagram-as-code runtime and bundled skill**: Added the `diagram` skill plus
  native `diagram_create`, `diagram_update`, and `diagram_validate` tools for
  validated Mermaid-first diagrams, with PlantUML, Graphviz DOT, and Excalidraw
  JSON adapters, source/rendered artifact persistence, SVG fallbacks, and
  diagram runtime events.
- **Slack Incoming Webhook channel**: Added outbound-only `slack_webhook`
  delivery for Slack Incoming Webhook URLs, including default and named targets,
  encrypted SecretRef storage, `hybridclaw channel add slack_webhook` setup,
  admin-console editing, Block Kit text chunking, reachability status, and
  managed POST-only network policy grants.
- **Concierge router plugin**: Moved concierge urgency routing into the
  repo-shipped `concierge-router` middleware plugin, preserving `/concierge`
  commands while giving routing middleware a plugin-owned pending-state store
  and authorized inbound webhook path for urgency-button callbacks.
- **A2A sender instance metadata**: A2A envelopes now carry
  `sender_instance_id`, derive it from canonical sender IDs for legacy payloads,
  expose it in audit summaries, and use `(envelope.id, sender_instance_id)` as
  the idempotency tuple for federated threads.
- **Model overlay metadata substrate**: Static model metadata can now carry a
  complete `model_overlay` contract shape and lookup helpers for GPT-5-family
  matching, preparing the runtime for model-specific behavior overlays without
  wiring an overlay applier yet.
- **Prompt-prefix trace metadata**: ATIF/OpenTraces session exports now include
  dynamic-context hashes and `prompt_prefix` entries alongside system prompt
  hashes, making prompt-cache behavior auditable per turn.

### Changed

- **System prompt prefix is byte-stable**: Per-turn dynamic context such as the
  current date, host, today's memory note, session summary, and retrieval
  snippets moved out of the system prompt into a post-prefix user context block
  so provider prefix caches can reuse the static system prompt.
- **Plugin discovery lists installable plugins**: `hybridclaw plugin list` and
  `/plugin list` now show installed plugins plus bundled/project-local
  installable plugins, with `installed` and `available` filters. Bare plugin
  IDs resolve through bundled and project `plugins/` catalogs, with project
  plugins taking priority.
- **Web chat sessions are easier to manage**: The chat sidebar can delete
  stored browser sessions, and local web clients automatically refresh their
  token when the gateway rotates the local web token.
- **TUI rendering handles Markdown tables**: The TUI now renders Markdown table
  blocks as terminal tables while preserving ordinary assistant text flow.

### Fixed

- **Agents page navigation links**: Corrected broken links on the generated
  agents page so navigation targets resolve properly.
- **Auxiliary provider fallback**: Auxiliary calls retry through the configured
  fallback provider path, including active local-provider preference and clearer
  fallback logging.
- **Global package install bootstrap**: Container dependency postinstall now
  falls back to `npm` when the outer install was invoked by `pnpm`, avoiding
  broken global package installs caused by forwarding the wrong package-manager
  executable and lifecycle env.
- **pnpm install compatibility**: Dependency verification avoids the Baileys
  libsignal Git dependency path that blocked `pnpm`-initiated installs.
- **Microsoft Teams optional dependency loading**: Teams Bot Framework support
  is lazy-loaded so installs that do not use Microsoft Teams are not blocked by
  that integration path.
- **Federated A2A duplicate handling**: Threads can now contain the same
  envelope ID from different sender instances while ambiguous envelope lookups
  fail fast unless the caller supplies `sender_instance_id`.

## [0.18.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.18.0) - 2026-05-13

### Added

- **GA4 reporting skill**: Bundled `ga4` adds production Google Analytics 4
  Data API reporting, request planning/review, gateway-injected bearer auth,
  service-account support, traffic-source, landing-page, time-series, revenue,
  session, and key-event reports, plus eval scenarios.
- **Hermes3000 long-form writing skill**: Bundled `hermes3000-writing` can
  authenticate through the gateway secret rail, manage portal-backed book
  projects, draft and revise chapters, update consistency memory, and export
  DOCX/PDF/EPUB/HTML deliverables without exposing JWTs to the agent context.
- **Video-from-script skill**: Bundled `video.from-script` turns approved
  avatar, voice, and script briefs into HeyGen MP4 jobs with planning, guarded
  async render start, status polling, optional download, and credit-spend
  approval gates.
- **Firecrawl self-host adapter**: The Firecrawl skill now supports
  self-hosted Firecrawl origins alongside managed API mode, including optional
  self-host auth for scrape, crawl, map, and extraction workflows.
- **Per-agent authenticated SearXNG search**: Agents can bind their own
  SearXNG base URL and bearer-token SecretRef, with bearer injection routed
  through the gateway HTTP proxy so tokens stay out of model context.
- **Reviewed skill unblock controls**: Blocked skills now appear in CLI, web,
  and gateway skill listings, and local operators can run `skill unblock` or
  use the Admin Skills page to record a reviewed scanner-bypass marker for an
  installed copy.
- **Browser stealth host policy**: Camofox stealth browsing is deny-by-default
  unless workspace policy explicitly allowlists the target host with
  `browser.stealth.rules`.
- **Node version guardrails**: Source checkouts now include `.node-version`,
  `.nvmrc`, and a `check:node` preflight so local builds and tests fail fast
  when they are not running on Node.js 22.

### Changed

- **SecretRef handling is store-first**: Runtime SecretRefs now accept the
  encrypted `store` source for new configuration. Legacy Browser Use Cloud
  env-backed refs are canonicalized to stored SecretRefs, and malformed legacy
  refs produce explicit configuration errors.
- **HybridAI auth diagnostics are clearer**: Provider discovery, health, bot
  lookup, and doctor output distinguish auth, configuration, and remote service
  failures more cleanly.
- **Web chat scrolling respects user position**: The chat UI now sticks to the
  bottom only when appropriate, preserves pinned scroll position while users
  read older content, and exposes a jump-to-latest affordance.
- **Console model-provider typing is narrower**: The chat model switcher no
  longer shares broader gateway provider types that were not part of the
  console UI contract.
- **Trace-judge live CI is less brittle**: Main-branch CI no longer blocks on
  missing trace-judge live secrets.

### Fixed

- **SearXNG bearer leakage risk**: SearXNG bearer values are no longer exposed
  through runtime env forwarding; configured SecretRefs are resolved only by
  the gateway proxy at request time.
- **Camofox navigation scope**: Stealth browser sessions now enforce both safe
  navigation schemes and host allowlisting before visiting a URL.
- **Browser credential fills**: SecretRef-backed browser fills require a
  resolvable page URL and calling skill name so host, selector, skill, and
  agent policy can be evaluated.

## [0.17.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.17.0) - 2026-05-12

### Added

- **Native media generation tools**: The container runtime now exposes
  `image_generate` and `video_generate` with provider adapters, managed output
  persistence, reference-media validation, usage metering, and bundled
  `image-generation` / `video-generation` skills. Image generation supports GPT
  Image, Gemini/Nano Banana, Grok, and FLUX families where configured; video
  generation supports OpenAI Sora and Google Veo families where configured.
- **New business and research skills**: Bundled skills now cover Airtable base
  and record work, FastBill invoicing, Firecrawl scrape/crawl/map/extract
  workflows, HeyGen avatar video generation and translation, Google Ads
  campaign operations, and SearXNG-backed `search.web`, `search.news`, and
  `search.images` workflows.
- **Threema Gateway channel**: HybridClaw can send outbound Threema Basic-mode
  text messages with setup docs, CLI configuration, doctor/status visibility,
  prompt hints, target validation, and delivery tests.
- **Camofox browser provider**: Browser automation can use a Camofox-backed
  provider with persistent profile support and the same provider factory path
  as local Playwright and Browser Use Cloud.
- **A2A inbound and trust surfaces**: JSON-RPC Agent Card inbound delivery,
  additional delegation envelope fields, a public-key trust ledger, and an
  admin A2A trust route extend the federation substrate.
- **Remote policy authority**: Signed remote policy updates can flow over the
  federation path with validation, audit records, and targeted tests.
- **Board card store**: The gateway now has a persisted card-store substrate
  for future admin work-board and agent-team coordination surfaces.
- **Trace-judge and anomaly evaluation path**: Skill trace judging gained a
  subscriber pattern, an offline eval gate, and a behavioral anomaly reranker
  for tool-call sequences.

### Changed

- **Admin console polish and performance**: Admin pages moved toward a shared
  `Card` primitive, the Usage rollup gained skeleton and metric loading states,
  live channel transport status is shown through toasts, the `/` command panel
  was rebuilt for better keyboard/a11y behavior, and expensive all-session
  scans/config fetches were removed from hot paths.
- **Vitest configuration is project-based**: Unit, integration, e2e, and live
  test configuration now share one project-aware Vitest setup instead of
  separate config files.
- **Browser credential handling is narrower**: Browser form fills now route
  through SecretRef injection gates rather than exposing credential material to
  the model or broad browser action context.
- **A2A delegation bearer auth**: Outbound A2A uses signed delegation JWTs as
  the HTTP bearer credential. `bearerTokenRef` remains a required explicit
  opt-in gate for non-loopback peer URLs, but its secret value is not sent on
  the wire.
- **NPM supply-chain controls are stricter**: Workspace install and release
  flows now enforce newer npm behavior, harden CI setup, and keep package-lock
  metadata aligned with the release pipeline.

### Fixed

- **A2A delegation revocation cleanup**: Expired delegation-token revocation
  records are pruned when new revocations are written, preventing stale
  short-lived token revocations from accumulating indefinitely.
- **Skill blocking is visible**: Blocked skills are surfaced instead of being
  hidden behind silent resolution failures.
- **Media path display-prefix handling**: Host paths that merely share a
  display prefix are no longer remapped as if they were inside the sandboxed
  media root.
- **Context ring source accuracy**: The web chat context ring reads usage from
  the correct source after session and UI routing changes.
- **Auxiliary model token limits**: Auxiliary provider calls honor configured
  max-token limits.
- **Console IME composition safety**: Chat composer key handling ignores IME
  composition events so slash/submit shortcuts do not interrupt text entry.
- **Release publish compatibility**: Release workflows invoke npm 11 on Node
  22 so npm package promotion uses the expected toolchain.

## [0.16.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.16.0) - 2026-05-07

### Added

- **macOS desktop wrapper**: Source builds can run `npm run desktop` for a
  native Electron shell around the existing `/chat` experience, with menu
  access to `/admin`, automatic local-gateway startup, packaged runtime
  preparation, and DMG build scripts.
- **Browser provider substrate**: Browser automation can run through a local
  persistent Playwright profile or Browser Use Cloud CDP sessions. Browser Use
  Cloud reads `BROWSER_USE_API_KEY` from the encrypted secret store, records
  usage/audit events, rejects unsafe local profile hints, and reports setup
  problems through `hybridclaw doctor browser-use`.
- **Cloudflare Tunnel provider**: Local gateways can use
  `deployment.tunnel.provider=cloudflare` with `CLOUDFLARE_TUNNEL_TOKEN` or
  certificate credentials from encrypted runtime secrets, plus a dedicated
  setup guide and admin tunnel status.
- **A2A outbound delivery**: Agent-to-agent envelopes can be delivered through
  JSON-RPC Agent Card peers or signed webhook peers with an outbox processor,
  retry/backoff, audit events, secret-backed bearer tokens, and operator
  escalation when delivery cannot continue safely.
- **A2A webhook inbound endpoint**: Gateways accept signed envelopes from
  trusted non-A2A peers at `POST /a2a/webhook/:peerId` with HMAC-SHA256
  verification, replay-window enforcement, per-peer SecretRef-backed shared
  secrets, sender/recipient validation against local agents, configurable
  per-peer rate limiting (default 60/min → 429), and structured audit events
  for every inbound POST.
- **Monthly invoice harvester skill**: The bundled
  `download-platform-invoices` skill collects official SaaS invoice PDFs and
  normalized records across Stripe, Google Ads, AWS, Azure, GCP, browser-driven
  SaaS portals, and DATEV Unternehmen Online handoff flows.
- **Warehouse SQL skill**: The bundled `warehouse-sql` skill reviews and runs
  read-only natural-language SQL against cached warehouse schemas, with a
  deterministic SQLite eval fixture and optional connector-backed execution for
  production warehouses.
- **Google OAuth secret routes**: `hybridclaw secret route ...` and
  `/secret route ...` can map URL prefixes to stored secrets or short-lived
  Google OAuth access tokens for direct `http_request` calls such as Google Ads
  API access.
- **Interactive escalation handoff**: Runtime middleware can pause for
  operator-facing escalation, collect resumable interaction context, and expose
  browser controls for continuing or resolving pending approvals.
- **AI-generated session titles**: `auxiliaryModels.session_title` can use an
  auxiliary model to title recent sessions from the first user message while
  preserving the local preview fallback when disabled.
- **Canonical identity discovery**: User and agent identities now have shared
  parsers, local instance-id allocation, and DNS-style TXT discovery records
  that map canonical identities to peer URLs and public keys for federation.
- **Per-agent liveness surface**: Gateway status now includes agent liveness
  metadata for admin and health surfaces.
- **Workflow definition schema**: YAML workflow definitions can declare
  agent-owned steps, transitions, and `stakes_threshold` escalation hints with
  validation coverage.
- **Classifier middleware contract**: Agent middleware can classify, warn,
  transform, block, or escalate pre-send and post-receive content, giving
  plugins such as `brand-voice` and confidential leak checks a shared runtime
  surface.
- **Console skill ZIP overwrite control**: The admin Skills page can upload a
  skill ZIP with an explicit `--force` overwrite option while preserving the
  existing skill if the replacement copy fails.

### Changed

- **Approval policy rule pipeline**: Container approval evaluation now runs
  through a hook-fed, policy-orderable rule pipeline, preserving the existing
  trust-store layout while giving plugins pre/post tool-use visibility.
- **Provider fallback chains**: `HYBRIDAI_FALLBACK_CHAIN` can route model calls
  to alternate providers on auth and rate-limit failures, with primary-provider
  cooldowns and streaming-safe retry gates.
- **A2A retry classification is shared**: Outbound A2A delivery and transport
  error handling use common retry classifications so transient failures,
  permanent failures, and escalation paths stay consistent.
- **Web chat sessions are easier to resume**: Recent-session history has clearer
  titles/snippets, agent switching is more stable, and active-session routing is
  less prone to stale agent state after UI changes.
- **Browser tooling is stricter and more capable**: Browser tools share
  navigation/profile guards, support reusable browser login state across host
  and container runtimes, and handle download-heavy invoice flows more
  predictably.
- **TUI activity rendering is calmer**: Tool activity rows stack and de-dupe
  more cleanly, repeated activity lines are suppressed, and `Esc` stops the
  active run instead of leaving the session running in the background.
- **Secret-bearing tool calls are narrower**: Gateway-side secret injection
  resolves non-LLM credentials and Google OAuth tokens at request time instead
  of exposing long-lived credentials to agent context.
- **Provider discovery errors are clearer**: Shared discovery-error helpers and
  normalized OpenRouter fallback hints keep model selection output less noisy.
- **IMAP polling failures stay local**: Email transport timeouts are contained
  to the IMAP connection path instead of leaking into broader gateway state.
- **Release automation is stricter**: Release workflows validate promoted image
  tags, pin newer checkout/setup actions, tolerate build-cache export failures,
  and enforce the Node engine during npm installs.

### Fixed

- **Gateway transport timeout resilience**: Host/container transport timeouts no
  longer bring down the gateway; affected runs fail locally while the gateway
  stays available for subsequent work.
- **Google Ads invoice harvesting**: Google Ads invoice discovery and PDF
  downloads use the correct InvoiceService and GoogleAdsService paths,
  including accessible-customer, manager-client, and billing-setup discovery.
- **TUI stop behavior**: Pressing `Esc` reliably stops the in-flight TUI
  session run.
- **TUI tool activity duplication**: Repeated and stacked tool rows no longer
  produce noisy duplicate output.
- **OpenRouter fallback hints**: HybridAI-prefixed model hints are stripped
  before OpenRouter fallback resolution.

## [0.15.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.15.0) - 2026-04-29

### Added

- **Backup and restore CLI**: `hybridclaw backup` creates WAL-safe runtime-home
  archives and `hybridclaw backup restore` validates manifests before
  rehydrating `~/.hybridclaw` on a fresh or recovered host.
- **Brand-voice output guard**: A repo-shipped `brand-voice` plugin can flag,
  rewrite, or block off-brand final responses using configured voice rules,
  banned phrases or patterns, required phrases, and optional classifier/rewriter
  models. The bundled `brand-voice` skill helps agents draft within those rules
  before the output guard fires.
- **Production Salesforce skill**: The bundled Salesforce skill now ships a
  fuller read-only helper, metadata/query references, eval scenarios, and
  server-side secret placeholder handling for inspecting org schema and SOQL
  records without writing credentials to disk.
- **Tailscale Funnel tunnel provider and admin status**: Local deployments can
  use `deployment.tunnel.provider=tailscale`, with `TS_AUTHKEY` resolved from
  encrypted runtime secrets when needed and kept out of process arguments. The
  admin console surfaces public URL and tunnel status alongside the existing
  gateway controls.
- **Web chat model switcher**: The chat composer can switch models from the
  browser using discovered provider catalogs, provider icons, model capability
  metadata, and the same active-session routing used by local slash commands.
- **Agent org chart, team revisions, and chronological CVs**: Agent metadata
  can model role, reporting, delegation, and peer relationships; admin agent
  pages keep restorable team-structure revisions; observed skill history can
  refresh per-agent CV output.
- **Warm process pool**: Host and container runners can keep a bounded adaptive
  pool of idle runtime processes for recently active agents, reducing cold-start
  latency while respecting max-idle, startup-claim, config-change, and
  memory-pressure limits.
- **Trace judge and trace preparation**: Local eval workflows can prepare
  redacted traces and dispatch them through an auxiliary judge model for skill,
  leak, and output-quality evaluation foundations.
- **Config value inspection**: `hybridclaw config get <key>` and `/config get
  <key>` return one resolved runtime config value without dumping the full
  config file.
- **GPT-5.5 model support**: Static and Codex-discovered model catalogs include
  `gpt-5.5`, `gpt-5.5-pro`, and `openai-codex/gpt-5.5`.

### Changed

- **Gateway health is less fragile**: Gateway status and health endpoints rely
  on cached provider checks instead of blocking on live model-provider probes,
  so transient provider failures no longer make the local gateway look down.
- **Token usage recording is buffered**: Usage events are normalized,
  size-capped, and batch-flushed asynchronously to reduce hot-path overhead
  while preserving audit records.
- **Runtime secrets are scrubbed more consistently**: Host/container agent
  runtimes share sensitive environment filtering and web-search credential
  injection so Brave, Perplexity, and Tavily keys are passed only through the
  intended secret channels.
- **Trajectory capture is stricter**: Stored skill trajectories run through
  PII, secret, and confidential-info redaction, and retention can be capped
  globally or per tenant.
- **Docs are consolidated under `docs/content`**: The duplicate legacy
  `docs/development` tree was removed after the content moved into the current
  docs hierarchy.

### Fixed

- **Loopback API auth is no longer bypassed**: Local OpenAI-compatible API
  requests require `WEB_API_TOKEN` or `GATEWAY_API_TOKEN`; loopback address
  alone is not treated as authentication.
- **Local TUI and gateway token handling is safer**: Generated gateway tokens
  are persisted once with serialized creation, shared with local TUI/eval
  clients, and no longer rewritten during later config reloads.
- **Ngrok tunnel reconnects are quieter**: Reconnect errors are deduplicated by
  normalized cause, audit run ids are correlated, and tunnel health checks stay
  enabled by default.
- **HybridAI-prefixed model names resolve cleanly**: Provider prefix handling
  recognizes `hybridai/...` model ids without noisy warnings.
- **Context ring popovers render correctly**: The web chat context usage ring
  once again shows its detail popover.

## [0.14.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.14.0) - 2026-04-28

### Added

- **Signal channel**: HybridClaw can connect to Signal through a
  `signal-cli` compatible daemon, with private-by-default DM and group
  policies, outbound chunk pacing, reconnect handling, admin QR linking, and a
  full setup guide.
- **Confidential-info filter and audit leak scanner**: Operators can define
  NDA-class client, project, person, keyword, and regex rules in
  `.confidential.yml`; prompts are redacted before model calls, responses are
  rehydrated for the user, and `hybridclaw audit scan-leaks` can inspect
  historic audit logs with severity and type filters.
- **Admin statistics and agent scoreboard**: The admin console adds
  `/admin/statistics` for session, message, token, cost, and channel trends,
  plus `/admin/agent-scoreboard` for per-agent skill scores, best skills,
  reliability, timing, and CV links.
- **Live context usage controls**: Web chat shows a live context-usage ring,
  local sessions support `/context`, and compaction headroom is visible before
  long-running chats hit the model window.
- **Packaged skill lifecycle**: Production skills can declare manifests with
  package id, version, capabilities, required credentials, and supported
  channels. Operators can install, upgrade, uninstall, list revisions, and roll
  back managed skills with audited snapshots.
- **Skill autonomy and stakes policy foundations**: `skills.autonomy` records
  per-agent skill autonomy levels, the container approval policy can classify
  high-stakes actions, and conditional skill availability can be routed through
  the generalized policy engine.
- **Deployment config and ngrok tunnel provider**: Runtime config now declares
  local or cloud deployment mode, public URLs, tunnel provider intent, and a
  built-in ngrok tunnel provider backed by the encrypted `NGROK_AUTHTOKEN`
  secret.
- **Nix and Homebrew packaging groundwork**: The repo ships a multi-arch Nix
  flake, NixOS service module, contributor dev shell, packaging notes, and a
  preview Homebrew formula for future tap publication.
- **Model metadata, pricing, and monthly usage rollups**: `/model info`,
  `/usage`, and the admin Models page surface discovered context windows,
  output limits, capabilities, pricing, and monthly per-model spend when
  providers expose that metadata.
- **Headful browser control**: Browser tools can run a visible Chrome session
  when a user explicitly asks for headed/headful control, while shared browser
  login profiles stay reusable for automation.
- **Agent-to-agent and trajectory persistence foundations**: The runtime can
  persist A2A envelopes and opt-in redacted skill-run trajectories, creating
  the data trail needed for multi-agent handoffs, skill evaluation, and future
  workflow tuning.

### Changed

- **Browser chat is more operational**: Chat navigation is session-id driven,
  recent sessions keep richer snippets, the composer can switch agents, slash
  result streams render correctly, and context-ring data is shared with the
  `/context` command.
- **Agent terminology and profile data are consistent**: The UI and internal
  persistence moved from coworker compatibility naming to agent naming, while
  agent configs gained owner, role, and CV fields.
- **Model and provider status is discovery-led**: Provider catalogs cache
  runtime discovery, merge pinned entries with discovered models, remove stale
  static pricing assumptions, and keep status/model-info output focused on the
  active model.
- **Approval and policy evaluation is more explicit**: Approval tiers can be
  influenced by autonomy level and stakes classification, invalid policy
  regexes and thresholds warn early, and unsafe realpath inspection during
  approval classification is avoided.
- **Local diagnostics are more precise**: Gateway debug startup flags can
  capture raw model responses and last prompts for local troubleshooting, and
  `doctor` resource hygiene can reclaim stale gateway artifacts more safely.
- **TUI and status reporting are quieter and more useful**: Proactive polling
  runs less often, streamed TUI responses preserve visible text, transient tool
  lines truncate cleanly, and status output includes tokens-per-second and
  time-to-first-token aware metrics.

### Fixed

- **Web fetch is guarded against SSRF**: Plain HTTP retrieval now enforces
  private-network protections more consistently before escalating to browser
  tools.
- **Headful browser launches require system Chrome**: Visible browser control
  refuses unstable headed macOS fallback launches and reports the required
  Chrome executable setup instead.
- **Voice turns survive relay reconnects**: Twilio voice relay reconnects no
  longer lose the active turn state while the gateway is handling a call.
- **Chat history and streaming edge cases are closed**: Result-only slash
  streams render, tool-call sentinels are stripped before storage, regenerated
  replies include tools used, context rings stay visible, and `/chat.html`
  redirects preserve query strings.
- **Skill lifecycle and manifest handling are stricter**: Managed skill
  installs require installed status records, validate snapshot entries, cap
  restored file modes, preserve unknown deployment tunnel providers, and reject
  upgrades for uninstalled packages.
- **Channel runtimes shut down more predictably**: WhatsApp and voice shutdown
  paths cancel stale work, Signal delivery validates daemon/account state, and
  channel send tools remain scoped to active transports.

## [0.13.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.13.1) - 2026-04-24

### Added

- **Delegation runtime reporting**: Delegated agent runs now persist their own
  request logs, audit tool events, model usage, token counts, and artifacts.
  `/status` rolls first-level delegate usage into the session summary when a
  dedicated delegate model is configured.
- **Dedicated proactive delegate model**: Added
  `proactive.delegation.model`, allowing operators to run delegated tasks on a
  different model from the parent orchestration turn.
- **Live delegate progress in the TUI**: Delegate batches now stream status
  blocks, child tool progress, token totals, and synthesized final-answer
  deltas into local TUI sessions without interrupting the active prompt.
- **Shared gateway command parsing helpers**: Added common parsing utilities
  for command ids, lower-case subcommands, and integer arguments across
  policy, concierge, skill, session, usage, export, audit, and schedule
  commands.

### Changed

- **Delegation prompts and approvals are clearer**: Delegation metadata moves
  into the child user prompt, subagents get more explicit tool-use guidance,
  duplicate delegate task titles are tracked independently, and `delegate` is
  classified as green because child tool calls are approved separately.
- **TUI activity rendering is more stable**: Running tools pulse in place,
  completed tools switch to a green checkmark, streamed text row counts are
  tracked incrementally, and delegate tool calls suppress partial parent text
  until delegate output is ready.
- **Console chat navigation is easier to reach**: The chat sidebar collapses
  to an icon rail on desktop, exposes a mobile topbar trigger, and respects
  reduced-motion preferences.
- **Encrypted web-search credentials feed runtimes consistently**: Brave,
  Perplexity, and Tavily API keys are resolved through the runtime secret store
  and injected into host/container agent runtimes from the active encrypted
  credentials, with environment variables used as fallback.
- **Liquid/LFM local model tool prompts are more compatible**: Local
  OpenAI-compatible Liquid/LFM requests include a compact tool list in the
  system prompt while preserving normal tool-choice request fields.

### Fixed

- **WhatsApp shutdown no longer waits on stale inbound batches**: Runtime
  shutdown cancels debounced WhatsApp batches, aborts in-flight handlers,
  stops typing indicators, and avoids starting new typing state after shutdown
  begins.
- **Console audit inspection stays visible while browsing events**: The audit
  detail panel remains sticky as the event list scrolls.
- **Whitespace-padded command arguments normalize consistently**: Gateway
  command handlers now trim ids and lower-case subcommands through shared
  helpers before dispatching.

## [0.13.0](https://github.com/HybridAIOne/hybridclaw/tree/v0.13.0) - 2026-04-22

### Added

- **Direct Anthropic provider**: Added first-class `anthropic/...` model
  routing with `hybridclaw auth login anthropic`, direct Messages API support,
  optional official `claude -p` transport in host sandbox mode, runtime model
  discovery, doctor/onboarding coverage, and container-side Anthropic provider
  execution.
- **JSON agent configuration command**: Added `hybridclaw agent config` for
  platform-generated agent JSON payloads. The command can upsert agent
  metadata, write bootstrap markdown files, optionally activate the agent, and
  import `imageAsset` URLs or local files into the agent workspace.
- **Bundled `gog` Google Workspace skill**: Added API-backed Gmail, Google
  Calendar, Drive, Contacts, Sheets, and Docs workflows through the `gog` CLI,
  including the Homebrew install helper and Google OAuth setup via
  `hybridclaw auth login google`. HybridClaw stores the OAuth client secret
  and refresh token in encrypted runtime secrets, mints short-lived access
  tokens on the host, and injects only `GOG_ACCESS_TOKEN` plus `GOG_ACCOUNT`
  into the agent runtime.
- **Bundled `gws` Google Workspace skill**: Added a Google Workspace CLI skill
  with progressive disclosure, auth preflight, and focused reference material
  for Calendar, Gmail, Drive, Docs, Sheets, and common workflows.
- **Bundled `gh-issues` skill**: Added a HybridClaw-native GitHub issue queue
  workflow that can fetch live issue lists, filter batches, confirm selected
  issues, deduplicate issue-fix branches, delegate focused PRs, watch queues,
  and revisit review feedback on open issue-fix PRs.
- **Bundled `excalidraw` skill**: Added editable `.excalidraw` diagram
  creation and revision guidance with reference material for colors, dark
  mode, examples, and an upload helper.
- **Small-business workflow tutorials**: Added a top-level Tutorials section
  covering practical owner, GTM, marketing, sales, DevRel, content, webinar,
  invoicing, and release-launch workflows.
- **Roman personality option**: Added a bundled Roman personality profile.
- **Console view switch and chat route refresh**: Added a shared view switch,
  larger admin brand treatment, collapsible desktop navigation, and a refreshed
  top-level `/chat` SPA route.
- **Release image promotion action**: Added a dedicated GitHub Action for
  release image promotion and tightened release-image workflow caching.

### Changed

- **Anthropic provider handling is production-routed**: Anthropic auth status,
  provider probing, model discovery, task routing, stream parsing, timeout
  behavior, Claude CLI credential lookup, and credential environment handling
  now use provider-specific code paths instead of OpenAI-compatible fallbacks.
- **Google Workspace skill routing prefers `gog` for API access**: The
  browser-oriented `google-workspace` skill now defers to the bundled `gog`
  skill when API-backed Gmail, Calendar, Drive, Contacts, Sheets, or Docs
  access is available.
- **Browser chat is the primary local web surface**: The gateway root routes to
  chat, `/chat` is mounted as a top-level console SPA route, the standalone
  chat view owns its viewport, and server-rendered pages use document
  navigation where appropriate.
- **Chat composer and message actions were refined**: Assistant message actions
  are always visible, regenerate precedes copy, the composer uses a two-row
  layout and the full main-column width, active sessions use accent text, and
  the new-conversation/send controls use lighter chrome.
- **Channel runtime lifecycle code is shared**: Built-in channel transports now
  use a shared runtime factory for common lifecycle handling, with explicit
  opt-outs where a transport needs custom behavior.
- **Provider discovery is more consistent**: Discovery caches and lookup
  aliases are shared across providers, HybridAI model alias lookup is indexed,
  provider integer parsing is centralized, and discovery refresh failures are
  logged consistently.
- **Prompt and tool summaries are cleaner**: Message-tool advertising is scoped
  to active channels, and prompt hook output avoids redundant comment noise.

### Fixed

- **Gateway restarts no longer hang during shutdown**: The gateway shutdown
  path now drains pending credential-save work in order, avoiding a restart
  hang during WhatsApp shutdown.
- **Honcho memory prefetch races are closed**: Prompt-context assembly waits
  for in-flight Honcho prefetch work before reading memory context.
- **Inactive channel send tools no longer leak into prompts**: The runtime only
  advertises message-send tools for channels that are active in the current
  configuration.
- **OpenRouter free-model lookups normalize correctly**: OpenRouter discovery
  handles free model lookup aliases consistently.
- **Slack runtime sends are guarded more tightly**: Slack send handling now
  validates runtime state before attempting delivery.
- **Agent avatars load behind web auth**: Chat agent avatars are fetched with
  authenticated requests and eagerly loaded when chat state initializes.
- **Chat replay restores request context from history**: Regenerating from a
  historic assistant message hydrates the stored replay request before
  resubmitting.
- **Collapsed sidebars keep the expected width**: The collapsed console rail
  shrinks to icon width and exposes nav tooltips instead of leaving excess
  sidebar space.
- **Google Workspace replies preserve user-visible addresses**: Assistant
  replies and streamed chat text no longer redact ordinary email addresses
  before they reach the user. Redaction still applies to audit, logging,
  approval/control previews, and observability paths.
- **HybridAI streaming avoids duplicate assistant text**: The HybridAI stream
  adapter now handles chunks that include both cumulative `message.content` and
  incremental `delta.content` without emitting the same text twice.

## [0.12.11](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.11)

### Added

- **Ephemeral `/btw` side-question command**: Added `/btw <question>` across
  local and Discord slash-command surfaces. It answers side questions from
  recent conversation context with a tool-less model call, without persisting
  the side exchange to session history.
- **Concurrent `/btw` threads in browser chat**: The built-in `/chat` surface
  accepts `/btw ...` while a primary run is active and renders those replies in
  a distinct side-thread presentation.
- **Bash tool state can persist between calls**: Added persistent bash state
  support so bash tool calls can preserve
  working directory, exported environment variables, and aliases for the active
  session by default, plus `container.persistBashState` and a matching
  `/admin/config` toggle (`Persistent bash state`) to disable this behavior
  when stateless shell calls are preferred.

### Fixed

- **Expected transport outages stay local and less noisy**: Discord, Email
  IMAP, and WhatsApp transport handlers now classify expected transient
  transport failures, keep reconnect loops local, and rate-limit repetitive
  outage logs.
- **Cloud artifact path remapping remains stable across workspace roots**:
  Artifact remapping now preserves host-resolved workspace paths when runtime
  and display roots differ, keeping generated files downloadable and attachable
  in cloud-backed sessions.
- **Remote skill import guardrails close unsafe/over-budget paths**: GitHub
  and skill-hub imports now enforce shared file-count/byte budgets during
  streaming downloads and consistently reject unsafe relative paths.

## [0.12.10](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.10)

### Added

- **Web chat conversation search**: The built-in `/chat` sidebar can now search
  recent sessions by title and show contextual match snippets, making it much
  easier to jump back into older browser conversations without paging through
  the default recent list.

### Changed

- **Bundled PDF creation handles longer documents cleanly**:
  `skills/pdf/scripts/create_pdf.mjs` now wraps long lines, respects explicit
  `\n` line breaks, and adds pages automatically when content exceeds the
  first page. The bundled PDF skill guidance and office-skills docs now call
  out the improved layout behavior.

### Fixed

- **Browser chat stays keyboard-ready between turns**: Both the built-in web
  chat and the console chat now restore focus to the composer after streamed
  replies finish, so back-to-back prompts no longer require clicking back into
  the input field.
- **Artifact downloads survive custom workspace display roots**: Container
  output artifacts are remapped against the active workspace path even when the
  runtime exposes a different display root such as `/app`, keeping generated
  files downloadable and attachable from chat surfaces.

## [0.12.9](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.9)

### Added

- **HybridAI skills eval suite**: Added `hybridclaw eval hybridai-skills
  [setup|list|run|results]` plus local `/eval hybridai-skills ...` flows that
  harvest the "Try it yourself" prompts from the bundled skills guides into a
  fixture set and grade which documented skill actually fired from the model's
  tool trace. It also includes `--explicit` for
  forced `/<skill> ...` invocation, richer result traces with observed skill,
  artifact presence, and counted tool-call totals, and fresh-agent cleanup so
  temporary eval workspaces, sessions, and audit trails do not accumulate after
  grading.

### Changed

- **`/admin/gateway` now reloads config instead of restarting the runtime**:
  The browser action now uses `Reload Gateway`, which refreshes runtime config
  and secrets through the admin API without tearing down the enclosing
  workspace container. Local/manual `hybridclaw gateway restart` stays
  available when a full restart is still required.

### Fixed

- **Unattended eval runs no longer stop on tool approvals**: Eval-profiled
  loopback requests now auto-approve tools end to end, expose execution-session
  and artifact-count response headers for correlation, and let detached local
  eval runs finish without manual approval interruptions.
- **Agent image builds are quieter in CI**: The container Dockerfile now sets
  `DEBIAN_FRONTEND=noninteractive` for the apt-based image layers and
  Playwright's `install-deps chromium` step, eliminating repeated `debconf`
  frontend fallback warnings during release and snapshot builds without
  changing the installed package set or runtime behavior.

## [0.12.8](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.8)

### Changed

- **`hybridclaw update` can restart the gateway automatically**: After a
  successful global npm upgrade, HybridClaw now attempts to restart a running
  local gateway with its recorded launch command and flags. If no running
  gateway is found, or the recorded process cannot be replayed or signalled,
  the CLI falls back to manual `hybridclaw gateway restart` instructions.
- **Container status is more informative**: `hybridclaw gateway status` and
  `!claw status` now include the configured container image name plus the
  resolved image version and short image id when sandbox mode is `container`.
- **Release-built agent images carry version metadata**: `npm run
  build:container` now passes the container package version into the image's
  OCI labels so runtime status output can report the actual image version when
  available.
- **Bundled deliverable guidance now prefers workspace-relative outputs**:
  Built-in prompt hooks and the PDF skill now reserve `/tmp` for scratch files
  and direct final PDFs, reports, and similar user-visible outputs into the
  workspace so they persist and can be attached.

### Fixed

- **Source-checkout Docker workspaces bootstrap `node_modules` correctly**:
  Container launches now pre-stage or repair the workspace `node_modules`
  symlink to `/app/node_modules`, so bundled JS skills can import repo-managed
  dependencies reliably inside Docker even when a stale host symlink already
  exists.
- **Default agent image release and pull flow no longer depends on GHCR**:
  The packaged runtime now pulls the default `hybridclaw-agent` image from
  Docker Hub only, and the release workflow stops publishing the private GHCR
  agent image or advertising a dead fallback path.
- **Ordered-list rendering is restored across chat and docs surfaces**: Web
  chat, docs pages, and console markdown rendering now preserve ordered-list
  numbering across intervening bullets, support nested list indentation, and
  handle LLM-emitted `**1. Heading**` list items correctly.

## [0.12.7](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.7)

### Added

- **Nine new external API providers**: Google Gemini (`gemini/`), DeepSeek
  (`deepseek/`), xAI / Grok (`xai/`), Z.AI / GLM (`zai/`), Kimi / Moonshot
  (`kimi/`), MiniMax (`minimax/`), DashScope / Qwen (`dashscope/`), Xiaomi
  MiMo (`xiaomi/`), and Kilo Code (`kilo/`). Each provider supports
  `auth login`, `auth status`, and `auth logout` with `--api-key`,
  `--base-url`, `--model`, and `--no-default` flags, plus full runtime config
  enablement and model-prefix routing.
- **Runtime model discovery for OpenAI-compat remote providers**: The nine
  providers above now auto-discover their current model lineups at runtime
  via `GET <baseUrl>/models` and surface them through `/model list <provider>`
  alongside any user-pinned entries in `<provider>.models`. Discovered models
  are cached for one hour, deduplicated with pinned entries, and silently
  fall back to the configured list if the provider's `/v1/models` endpoint is
  unreachable, absent (404), or otherwise errors.
- **ByteRover memory plugin**: New bundled `byterover-memory` external memory
  provider that injects prompt-time recall through `brv query`, exposes
  `brv_query` / `brv_curate` / `brv_status` model tools, and curates
  completed turns, native memory writes, and pre-compaction summaries into
  ByteRover's Context Tree. Works offline by default with optional cloud sync.
- **Mem0 memory plugin**: New bundled `mem0-memory` external memory provider
  that layers Mem0 profile and search recall on top of built-in memory,
  exposes `mem0_profile` / `mem0_search` / `mem0_conclude` tools and a local
  `/mem0 ...` command surface, mirrors completed turns and explicit native
  memory writes into Mem0, prefetches profile context on `session_start`, and
  curates compaction snapshots before older turns are archived.
- **Skill availability controls**: Added `hybridclaw skill enable <name>
  [--channel <kind>]`, `hybridclaw skill disable <name> [--channel <kind>]`,
  interactive TUI `/skill config` toggles, and matching gateway slash-command
  support for enabling or disabling skills globally or per channel.
- **OpenTelemetry distributed tracing**: The gateway can now emit spans for
  message handling, agent runs, host/container execution, and skill loading to
  OTLP collectors when `OTEL_ENABLED=true` or
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set, with `traceId` / `spanId` correlation
  injected into structured logs.
- **Memory plugin and skills docs expansion**: Added a memory-plugin
  comparison guide, per-category bundled-skills guides, and richer browser
  docs prompt blocks with copy buttons and styled callouts.

### Changed

- **Model and provider surfaces now share one registry**: `/model list`,
  `/model info`, provider status output, and `/admin/models` now use the same
  data-driven provider catalog, show model counts consistently, and sort
  enabled or reachable providers first in the admin console.
- **Fresh installs default HybridAI to `gpt-5.4-mini`**: New runtime homes now
  seed `hybridai.defaultModel` from the shared `DEFAULT_HYBRIDAI_MODEL`
  constant so onboarding, migration, and fresh-install defaults stay aligned.
- **Kilo Code base URL migrated to `https://api.kilo.ai/api/gateway`**: The
  retired `api.kilocode.ai` host now serves a marketing site, so the default
  Kilo Code base URL has been updated across `config.ts`, the runtime config
  defaults, the `auth login kilo` normalizer (suffix `/api/gateway`), and
  `config.example.json`. Persisted runtime configs still pointing at
  `https://api.kilocode.ai/v1` are silently migrated to the new URL on load
  so existing installations self-heal.
- **Codex model catalog handling is more resilient**: HybridClaw now pins the
  `client_version` needed for the full upstream Codex catalog and ships static
  supplemental entries for UI-known Codex variants when the upstream list is
  temporarily incomplete.
- **Renamed `HybridAIRequestError` → `ProviderRequestError`**: The error class
  wraps failures from every OpenAI-compat provider (HybridAI, OpenRouter,
  Mistral, Kilo Code, local Ollama, etc.), so the HybridAI-specific name was
  misleading. The error-message prefix now reads `Provider API error <status>`
  instead of `HybridAI API error <status>`. `HybridAIRequestError` is kept as
  a deprecated alias for backward compatibility; new code should import
  `ProviderRequestError` directly.
- **Simpler `formatModelForDisplay` rule**: Models that already carry a
  provider prefix (`kilo/...`, `gemini/...`, etc.) no longer incorrectly pick
  up a leading `hybridai/`. The function now treats any slash-containing
  non-`hybridai/` model as already-namespaced, removing the fragile
  `NON_HYBRID_PROVIDER_PREFIXES` whitelist dependency for this path.
- **TUI reply metadata is clearer**: The usage footer now shows the active
  skill name alongside tools and plugins when a response was driven by a
  skill.
- **Plugin dependency checks are quieter**: `plugin install` and
  `plugin check` now treat global binaries as satisfying declared
  dependencies, skipping unnecessary npm or pip installs and approval prompts
  when the required executable is already on `PATH`.
- **Memory plugin docs standardized**: All six memory-plugin doc pages now follow
  the same structure: Prerequisites, HybridClaw Setup, Config, Commands,
  Example Prompts & Use Cases, Tips & Tricks, and Troubleshooting. Added
  external links, local vs cloud options, and researched tips for each.
- **Browser docs prompt UX expanded**: The docs shell now groups tips and
  multi-step prompts into styled callouts, adds copy buttons for try-it
  blocks, and publishes bundled-skill pages grouped by category.

### Fixed

- **Bundled ESM skill scripts resolve repo-managed dependencies in the
  sandbox**: Source-checkout container runs now symlink the workspace
  `node_modules` directory into the agent workspace so bundled skill scripts
  can import repo dependencies consistently inside Docker.
- **`/auth status` suggestions list every supported provider**: Slash-command
  provider completion and status suggestions now include the full provider set
  instead of omitting newer backends.
- **Mem0 sync no longer sends unsupported `app_id` fields**: Stored-turn
  mirroring and later recall now work against Mem0's accepted write shape.
- **Dream consolidation works for cloud sessions**: `/dream` memory
  consolidation now runs correctly when the session is backed by cloud state.
- **Fresh-install model migration tracks the shared default constant**:
  Migration logic now respects `DEFAULT_HYBRIDAI_MODEL` instead of relying on
  a stale sentinel when deciding whether a runtime home is still on the
  original default model.
- **Browser docs renderer edge cases**: Separate callout blocks no longer
  merge together, copy actions strip leading numbering more reliably, and the
  docs copy icon renders and positions consistently across browsers.

## [0.12.6](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.6)

### Added

- **Twilio voice channel**: Added a built-in Twilio ConversationRelay phone
  channel with inbound webhook handling, outbound `hybridclaw gateway voice
  call <number>` support, admin-console setup, and a dedicated setup and
  troubleshooting guide.
- **Salesforce skill**: New bundled skill for enterprise CRM integration with
  OAuth token binding, a dedicated `secret` CLI surface for credential
  management, and hardened field-level configuration.
- **Local skill import**: `skill import` now accepts local filesystem
  directories and `.zip` archives as sources, with persistent import-source
  markers so locally-imported skills retain personal trust across restarts.
- **Admin approvals policy console**: New `/admin/approvals` interface for
  viewing and managing approval policies from the browser.
- **Console chat UI**: Migrated the legacy standalone chat UI into the console
  React app with unified channels selection and improved upstream error
  handling.
- **Doctor resource hygiene**: `hybridclaw doctor` now includes a resource
  hygiene maintenance pass that detects and cleans stale gateway artifacts,
  with cached DB snapshots and disk-state diffing for efficient checks.
- **Fetch Email-Config button**: The admin email channel editor includes a
  one-click button to fetch and validate HybridAI mailbox credentials.
- **XLSX skill creation script**: Bundled creation script prevents silent
  generation failures when the xlsx skill produces spreadsheet output.
- **ToggleGroup component**: New `ToggleGroup` / `ToggleGroupItem` UI
  primitive used across the admin console for binary-toggle controls.
- **Provider health panel**: Inline login action and inactive-provider
  collapse in the admin console for quicker provider triage.

### Changed

- **Per-channel instructions in `/admin/channels`**: The admin console now
  lets operators edit transport-specific prompt guidance, and runtime config
  exposes the same values under `channelInstructions.*` so channels such as
  voice can enforce spoken-output rules without editing prompt files directly.
- **OAuth token domain binding**: Bearer tokens are now bound to their OAuth
  issuer domain to prevent cross-domain exfiltration, and the gateway proxy
  auto-captures tokens using config constants instead of raw environment
  variables.
- **Secret CLI simplification**: Removed the `[--raw]` option from
  `secret status` and `secret set`, streamlining the operator-facing surface.
- **CI pipeline split**: Unit tests now run as parallel lint and test jobs
  with a shared `setup-node-workspace` composite action and PR-level
  concurrency groups that cancel stale runs.
- **Security scanner hints**: Block messages now include actionable override
  hints so operators understand how to respond to policy violations.
- **DRY provider utilities**: Refactored model-matching and `agentId`
  normalization into shared provider utilities with prefix-aware matching.

### Fixed

- **Voice approval and relay handling**: Spoken approval replies normalize more
  reliably, voice turns skip the usual yellow implicit wait, and the Twilio
  relay path handles disconnect, interrupt, and runtime-unavailable cases more
  cleanly instead of dropping into noisier failure states.
- **Memory-flush pool slot leak**: Host processes spawned during memory-flush
  no longer leak worker pool slots, and empty sessions are cleaned up
  automatically.
- **Stream terminated retry**: Terminated stream errors are now retried
  correctly, preserving PDF creation workflows across transport retries.
- **Skill scanning and promotion**: Runtime-created skills in agent workspace
  directories now appear in `/skill list` and are promoted to the managed
  directory on save.
- **Teams webhook resilience**: Missing Teams credentials on incoming webhook
  requests are handled gracefully instead of crashing the handler.
- **AuthProvider callback stability**: Stabilized React `AuthProvider`
  callbacks with memoized context values to prevent unnecessary re-renders.
- **Upstream error mapping**: Nested HybridAI error payloads are unwrapped
  and mapped to `502` responses to avoid gateway auth confusion, with
  `no-store` cache headers on error responses.
- **Skip-skill-scan persistence**: The `--skip-skill-scan` CLI decision is
  now persisted so the runtime guard honors it across restarts.

## [0.12.5](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.5)

### Added

- **Admin agent file editor**: The admin console now includes `/admin/agents`
  for editing each registered agent's allowlisted workspace bootstrap markdown
  files, with saved revision history and restore controls.

### Changed

- **Local TUI approval workflow**: Pending approvals in `hybridclaw tui` open a
  keyboard-driven picker with `Up`/`Down` navigation, `Enter` confirmation,
  number-key quick select, `Esc` to skip, and a text fallback for
  non-interactive terminals.
- **Admin destructive-action confirmations**: Browser-based operator flows now
  use explicit confirmation dialogs for destructive actions so restarts,
  deletes, and similar changes require a deliberate confirm step.

### Fixed

- **TUI approval replay handling**: Replayed or restated approval prompts reuse
  cached approval details more reliably, and web `/approve` flows preserve
  pending-approval metadata so follow-up approvals reopen the same picker
  instead of dropping back to raw text.
- **TUI exit summaries**: Exit output either shows the remote usage/tool/file
  totals for the session or an explicit unavailable summary, and gateway
  history breakdowns resolve canonical TUI session ids consistently for
  tool/file counts.
- **Invalid runtime-config recovery**: Interactive onboarding can restore the
  last known-good saved config snapshot, or roll back to the newest saved
  revision, when `config.json` becomes invalid JSON instead of leaving setup
  stuck on in-memory defaults.
- **Transport retry backoff**: Retry-aware channel transports honor
  service-provided `Retry-After` delays and reject invalid retry values early
  instead of silently retrying with bad timing.
- **Email first-sync cursor handling**: The built-in email transport seeds a
  missing mailbox cursor from the current mailbox head so old inbox mail is not
  replayed as new traffic on first startup, while later restarts still deliver
  mail that arrived while the gateway was offline.
- **WhatsApp startup reliability**: The built-in WhatsApp transport disables
  Baileys init queries that can trigger intermittent `400`/`bad-request`
  failures during startup and pairing.

## [0.12.4](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.4)

### Added

- **Slack channel transport**: Added a built-in Slack Socket Mode transport
  with `hybridclaw auth login slack`, DM and channel policy controls,
  thread-aware session routing, file/media handling, approval buttons, and a
  dedicated setup guide for operator rollout.
- **Immediate one-shot scheduler jobs**: Added config-backed `one_shot` jobs
  that run immediately, retry up to `maxRetries`, preserve review state, and
  surface richer delivery output across the gateway and admin scheduler UI.
- **Mem0 memory plugin**: Added a bundled `mem0-memory` plugin so local
  HybridClaw installs can mirror turns into Mem0 cloud memory, inject
  prompt-time Mem0 recall, expose `mem0_*` tools, and mirror explicit native
  memory writes back into Mem0.

### Changed

- **Admin console dialog and toast UX**: Replaced inline banners with
  accessible dialog/toast primitives, tightened scheduler and jobs feedback
  flows, and refined the mobile topbar/sidebar interaction.
- **Per-agent skill filtering**: Agent `skills` settings narrow the
  globally enabled skill set, while omitting `skills` keeps the existing
  global scope for backward compatibility.
- **Approval presentation across channels**: Gateway approval copy and channel
  actions render more consistently across Discord, Slack, and
  gateway-managed approval surfaces.

## [0.12.3](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.3)

### Added

- **Telegram Bot API transport**: Added a built-in Telegram channel with
  BotFather token setup, DM/group policy controls, admin Channels support,
  managed `TELEGRAM_BOT_TOKEN` storage, inbound media handling, and canonical
  outbound `telegram:<chatId>` send targets.
- **Built-in memory inspection command**: Added local `/memory inspect
  [sessionId]`, `/memory query <query>`, and `hybridclaw gateway memory inspect
  [sessionId]` diagnostics to show `MEMORY.md`, today's daily note, recent raw
  history, `session_summary`, recent semantic-memory rows, canonical
  cross-session recall state, and the exact prompt-memory block the current
  session would attach for a query.
- **Admin email mailbox surfaces**: Added admin-console and gateway support for
  browsing the configured built-in email mailbox, listing folders and message
  metadata, and composing or replying from the operator UI without leaving the
  HybridClaw runtime.
- **Native LOCOMO eval workflow**: Added managed `hybridclaw eval locomo ...`
  and local `/eval locomo ...` flows with official dataset setup, QA and
  retrieval modes, detached run logs, and retrieval sweeps across backend,
  rerank, tokenizer, and embedding settings.
- **Bundled GBrain plugin**: Added the bundled `gbrain` plugin so HybridClaw
  can query an external GBrain knowledge brain for prompt-time recall, expose
  discovered `gbrain_*` tools, and provide `/gbrain ...` passthrough operations
  from local sessions.
- **Bundled manim-video skill**: Added a repo-shipped `manim-video` skill with
  setup helpers, reference packs, and render guidance for scripted explainer
  videos and animation workflows.

### Changed

- **Model catalog and provider routing**: `/model list` plus selector surfaces
  now use provider-scoped model catalogs for Codex, OpenRouter, Mistral, and
  Hugging Face, Codex models use explicit `openai-codex/...` ids, and status
  output carries discovered model metadata more consistently.
- **Admin console navigation and channel UX**: The embedded console now uses a
  structured sidebar taxonomy, a clearer channel catalog, richer channel/email
  surfaces, and refreshed icons/layout so operators can reach models, channels,
  plugins, tools, and gateway state from one navigation frame.
- **Shared inbound media cache**: Email, Telegram, WhatsApp, and Microsoft
  Teams now stage locally downloaded inbound media under the shared
  `uploaded-media-cache` runtime directory instead of per-channel temp
  folders, aligning cleanup and runtime-safe media paths across those
  transports.
- **Telegram config reload behavior**: Running gateways now restart the
  Telegram integration automatically when `telegram.*` config changes land, so
  most setup edits apply within a few seconds without a full gateway restart.
- **Per-agent skill allowlists**: Agent `skills` settings now narrow the
  globally enabled skill set, while omitting `skills` keeps the existing
  globally enabled scope for backward compatibility.

### Fixed

- **TUI sandbox preflight**: `hybridclaw tui` now follows the sandbox mode
  reported by a reachable gateway, avoiding unnecessary container rebuild
  checks when the running gateway is already in host mode and vice versa.
- **HybridAI auxiliary model prefixes**: Auxiliary-model routing now strips the
  leading provider prefix correctly so HybridAI requests do not fail when the
  configured model name already carries a provider namespace.
- **GBrain tool discovery robustness**: The bundled GBrain plugin now times out
  cleanly when `gbrain --tools-json` hangs and reports parse failures with
  stdout/stderr previews during discovery.

## [0.12.2](https://github.com/HybridAIOne/hybridclaw/tree/v0.12.2)

### Added

- **Honcho memory plugin**: Added a bundled `honcho-memory` plugin so local
  HybridClaw installs can mirror conversations into Honcho, inject prompt-time
  recall and direct Honcho tools into later turns, and promote native user
  profile saves into Honcho conclusions without disabling built-in memory.
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

- **Admin console tools and gateway UX**: The `/admin/tools` catalog now only
  shows live built-in and enabled plugin tools, all admin tables support
  click-to-sort headers, the Tools view now labels usage as `Invocations`,
  and the Gateway page adds a managed restart action with clearer restart
  state handling.
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
  local TUI and web sessions expose `/secret list|set|status|unset|route ...`,
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
- **Auxiliary task/provider routing**: Added auxiliary routing and
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
