# HybridClaw

[![CI](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/HybridAIOne/hybridclaw/gh-pages/badge/coverage.json)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hybridaione/hybridclaw)](https://www.npmjs.com/package/@hybridaione/hybridclaw)
[![Node](https://img.shields.io/badge/node-22.x-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/en/download)
[![License](https://img.shields.io/github/license/HybridAIOne/hybridclaw)](https://github.com/HybridAIOne/hybridclaw/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://hybridaione.github.io/hybridclaw/docs/)
[![Powered by HybridAI](https://img.shields.io/badge/powered%20by-HybridAI-blueviolet)](https://hybridai.one)
[![Discord](https://img.shields.io/badge/Discord-join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/jsVW4vJw27)

<img width="420" height="397" alt="HybridClaw - Enterprise-ready self-hosted AI assistant runtime" src="docs/hero.png" />

## All of the Claw, None of the Chaos
### Enterprise-ready self-hosted AI assistant runtime

HybridClaw is a self-hosted AI assistant runtime for teams that need control,
security, and operational visibility. It combines sandboxed execution, secure
credentials, approvals, persistent memory, and admin surfaces behind a single
gateway.

Connect it to Discord, Discord Incoming Webhooks, Slack, Slack Incoming
Webhooks, Signal, WhatsApp, Telegram, Microsoft Teams, email, fax, Twilio
voice, or the web. Run it locally, deploy it for business workflows, and keep your
agents, secrets, and data under your control.

[Quick Start](https://hybridaione.github.io/hybridclaw/docs/getting-started/quickstart) ·
[Installation](https://hybridaione.github.io/hybridclaw/docs/getting-started/installation) ·
[Configuration](https://hybridaione.github.io/hybridclaw/docs/reference/configuration) ·
[Migration](https://hybridaione.github.io/hybridclaw/docs/reference/commands#migration) ·
[Contributing](./CONTRIBUTING.md) ·
[Support](./SUPPORT.md)

## Pick your path

- Want the shortest path to a running assistant? Start with
  [Quick Start](https://hybridaione.github.io/hybridclaw/docs/getting-started/quickstart).
- Want the full setup flow with providers, channels, and admin surfaces? Start
  with [Installation](https://hybridaione.github.io/hybridclaw/docs/getting-started/installation)
  and [Authentication](https://hybridaione.github.io/hybridclaw/docs/getting-started/authentication).
- Want to migrate from OpenClaw or Hermes? Start with the
  [migration commands](https://hybridaione.github.io/hybridclaw/docs/reference/commands#migration).
- Want to contribute from source? Start with [CONTRIBUTING.md](./CONTRIBUTING.md)
  and the maintainer docs under [docs/content/README.md](./docs/content/README.md).

## Coming from OpenClaw or Hermes?

```bash
hybridclaw migrate openclaw --dry-run
hybridclaw migrate hermes --dry-run
```

Preview and import compatible state from OpenClaw or Hermes in minutes.
Imports compatible skills, memory, config, and optional secrets.

## HybridAI Platform Advantage

HybridClaw is the runtime. HybridAI is the (optional) platform layer around it.

HybridAI adds:

- one-click cloud deployment
- enterprise shared RAG / knowledge
- access to current models from Anthropic, OpenAI, Google, xAI, and others
- observability across multiple agents
- built-in email addresses for your agents
- ready-to-run virtual coworkers

## Get running in 2 minutes

One-line install on Linux/macOS (ensures Node 22, installs the CLI, runs
onboarding):

```bash
curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash
```

Or do it by hand with npm:

```bash
npm install -g @hybridaione/hybridclaw
hybridclaw onboarding
hybridclaw gateway
hybridclaw tui
```

Open locally:

- Chat UI: `http://127.0.0.1:9090/chat`
- Admin UI: `http://127.0.0.1:9090/admin` for channels, versioned agent files,
  scheduler, audit, statistics, config, secrets, output guard, and
  channel-specific instructions
- Agents UI: `http://127.0.0.1:9090/agents`
- OpenAI-compatible API: `http://127.0.0.1:9090/v1/models` and `http://127.0.0.1:9090/v1/chat/completions`

Requirement: Node.js 22 (Docker recommended for sandbox)

Desktop wrapper from source:

```bash
npm install
npm run desktop
```

The Electron workspace opens the existing `/chat` surface in a native macOS
window, exposes `/admin` from the app menu, reuses a running local gateway when
available, and starts the bundled gateway automatically when it is not already
listening on `http://127.0.0.1:9090`.

Release notes live in [CHANGELOG.md](./CHANGELOG.md), and the browsable
operator and maintainer manual lives at
[hybridaione.github.io/hybridclaw/docs](https://hybridaione.github.io/hybridclaw/docs/).

## See it in Action

Once the gateway is running, open HybridClaw locally:

- Web Chat: `http://127.0.0.1:9090/chat`
- Web Chat keeps a recent-session sidebar and can search conversation titles
  with contextual snippets before you reopen or delete an older browser session
- Web Chat shows live context-window usage, accepts `/context`, and lets you
  switch the active agent and model from the composer; active agent switching is
  preserved across session reloads and UI route changes
- Web Chat keeps scrolling pinned when you read older messages and shows a
  jump-to-latest affordance when new output arrives below the current viewport
- Web Chat accepts `/btw <question>` side questions while a primary run is
  active, so you can ask an ephemeral follow-up without interrupting the
  current run
- Web Chat renders slash-command output as command results and lets operators
  rate persisted assistant responses with thumbs-up/down feedback that feeds
  observability and skill-improvement signals
- Admin Console: `http://127.0.0.1:9090/admin` for channels, versioned agent files,
  scheduler, audit, statistics, config, secrets, output guard, A2A inbox threads, and
  channel-specific instructions
- Agent Dashboard: `http://127.0.0.1:9090/agents`
- or connect Discord, Discord Incoming Webhooks, Slack, Slack Incoming
  Webhooks, Signal, WhatsApp, Telegram, Microsoft Teams, Email, Fax

## Operator workflows

- Install from npm, source, or the multi-arch Nix flake; a preview Homebrew
  formula is available for `--HEAD` builds while stable tap publication is
  prepared.
- `hybridclaw gateway status` reports sandbox/runtime details, and in
  container mode it includes the configured image name plus the resolved
  version and short image id.
- `hybridclaw backup` creates a WAL-safe archive of the runtime home, and
  `hybridclaw backup restore <archive.zip>` validates the archive before
  replacing local runtime state.
- `hybridclaw update --yes` upgrades a global npm install and auto-restarts a
  running local gateway with its original launch parameters when possible,
  falling back to `hybridclaw gateway restart` if not.
- `/admin/agents` edits allowlisted bootstrap markdown files such as
  `AGENTS.md`, keeps saved revisions, and restores earlier versions from the
  browser.
- `/admin/statistics` reports message, session, token, cost, and channel trends
  across a selected date range.
- The Usage rollup surfaces loading skeletons, cost metrics, and per-model
  spend summaries without scanning every stored session on page load.
- `/admin/agent-scoreboard` ranks agents by observed skill scores, reliability,
  timing, best skills, and CV links.
- `/audit turn <n>` and `/audit run <runId>` show focused turn traces for
  debugging one request without reading the full session audit stream.
- `hybridclaw agent config` accepts generated JSON payloads to upsert agent
  metadata, write bootstrap markdown, import profile images into the agent
  workspace, and optionally activate the agent.
- `/admin/channels` edits transport config, encrypted channel credentials,
  Signal QR linking, Twilio voice settings, and per-channel instructions that
  are injected into prompts at runtime.
- `/admin/secrets` lists stored and declared-but-empty secrets by metadata
  only, supports overwrite and unset actions, and never returns cleartext
  secret values to the browser.
- `/admin/output-guard` configures response guardrails and plugin-backed
  output classification without editing runtime config by hand.
- `slack_webhook` targets provide outbound-only Slack Incoming Webhook delivery
  with encrypted webhook URLs, named destinations, Block Kit text chunking,
  reachability status, and POST-only network policy grants.
- `discord_webhook` targets provide outbound-only Discord Incoming Webhook
  delivery with encrypted webhook URLs, named destinations, message chunking,
  reachability status, and POST-only network policy grants.
- `/admin/approvals` manages approval policies from the browser.
- Approval policy evaluation runs through a hook-fed rule pipeline, so
  workspace policy ordering and plugin tool-use hooks share one approval path.
- `/admin/a2a-inbox` shows read-only A2A message threads across the instance,
  with sender, recipient, timestamp, intent, and content for each message.
- `/admin/a2a-trust` shows the local A2A public-key trust ledger for paired
  peer instances.
- `/admin/gateway` reloads runtime config and refreshes secrets from the
  browser, and shows public URL plus tunnel status, without tearing down the
  enclosing workspace container; keep `hybridclaw gateway restart` for
  local/manual full restarts.
- `/context` and the web chat context ring show current context-window usage,
  remaining headroom, and compaction counts for the active session.
- `/goal` stores a standing completion condition for the current thread and
  queues supervised continuations until the goal is judged complete, paused,
  cleared, interrupted, or blocked by approval policy.
- `/second-opinion` asks a stronger configured model to compare a question,
  validate the last answer, or fact-check with web-search evidence while
  honoring configured model context, confidentiality, and agent-budget limits.
- `proactive.delegation.model` can pin delegated work to a different model
  from the parent turn; `/status` shows delegate token totals and local-token
  share when that split is configured.
- `deployment.mode`, `deployment.public_url`, `deployment.tunnel.provider`, and
  `deployment.tunnel.health_check_interval_ms` describe local/cloud exposure
  and tunnel health cadence. The built-in ngrok, Tailscale Funnel, and
  Cloudflare Tunnel providers read `NGROK_AUTHTOKEN`, `TS_AUTHKEY`,
  `CLOUDFLARE_TUNNEL_TOKEN`, and Cloudflare certificate credentials from the
  encrypted runtime secret store.
- A2A cross-instance delivery resolves canonical peer IDs in order from the
  local deployment URL or active tunnel URL, the A2A public-key trust ledger,
  then DNS-style discovery when `HYBRIDCLAW_IDENTITY_DISCOVERY_ZONE` is
  configured.
- `container.warmPool` keeps a bounded adaptive pool of idle host/container
  runtimes for recently active agents when low cold-start latency matters.
- `container.persistBashState` controls whether bash tool calls share shell
  state (`cd`, exported env vars, aliases) across turns in the same active
  runtime session; `/admin/config` exposes the same setting as `Persistent bash state`.
- Agent budget config supports monthly USD/EUR caps and token caps; job and
  board budget chips show neutral, warning, and over-budget states for
  configured agents.
- `security.confidentialRedactionEnabled` controls whether optional
  `.confidential.yml` rules redact prompts and block matching outbound text;
  `/admin/config` exposes the same setting as `Confidential leak guard`.
- `hybridclaw audit scan-leaks` scans historical audit logs against optional
  `.confidential.yml` rules for NDA-class client, project, person, keyword,
  and regex matches.
- Generated artifacts remain downloadable and attachable even when the sandbox
  exposes a custom workspace display root such as `/app`.
- `hybridclaw tui` includes live delegate progress, pulsing tool rows,
  completion checkmarks, rendered Markdown tables, a keyboard-driven approval
  picker, and a ready-to-run `hybridclaw tui --resume <sessionId>` command on
  exit. Pressing `Esc` stops the active run and returns control to the prompt.
- `hybridclaw doctor` checks runtime health including resource hygiene
  maintenance for stale gateway artifacts. `hybridclaw doctor browser-use`
  checks the local Playwright browser automation substrate and can install
  missing Chromium support with `--fix`.
- `hybridclaw onboarding` and related local setup flows can restore the last
  known-good saved config snapshot or roll back to a tracked revision when
  `config.json` becomes invalid.
- `hybridclaw skill import` supports community sources, local directories,
  and `.zip` archives.
- `hybridclaw skill install <source>`, `skill upgrade`, `skill revisions`, and
  `skill rollback` manage packaged business skills with manifests, audit
  events, and snapshots.
- `hybridclaw skill list blocked` and `hybridclaw skill unblock <name>` let
  local operators review scanner-blocked skills and record a bypass marker for
  the installed copy when the finding has been accepted.
- Bundled skills include CRM, finance, infrastructure, monitoring,
  home-automation and solar monitoring, fax, local PII redaction, media,
  search, and office workflows. Skill setup guides live in the
  [Skills Catalog](https://hybridaione.github.io/hybridclaw/docs/guides/skills/).
- The bundled tutorials cover owner, GTM, marketing, sales, DevRel, content,
  invoicing, webinar, and release-launch workflows that can run from the TUI,
  web chat, or connected channels.
- `hybridclaw eval hybridai-skills` turns the bundled skills pages' "Try it
  yourself" prompts into a local eval suite, and live summaries surface the
  observed skill, artifact presence, and counted tool-call totals.
- Channel delivery stays predictable: email seeds its first mailbox cursor from
  the current head instead of replaying old inbox mail, retry-aware transports
  honor server `Retry-After` backoff, expected transient Discord/Email/WhatsApp
  transport outages stay local with rate-limited logging, and WhatsApp startup
  avoids intermittent init-query bad-request failures.

## Models, Skills, and Memory

- `hybridclaw auth login` and `/model list` cover HybridAI, Codex,
  Anthropic, OpenRouter, Mistral, Hugging Face, Gemini, DeepSeek, xAI, Z.AI,
  Kimi, MiniMax, DashScope, Xiaomi, Kilo Code, and local backends such as
  Ollama, LM Studio, llama.cpp, and vLLM. Remote OpenAI-compatible providers
  can merge runtime-discovered model catalogs with operator-pinned lists.
- `/model info`, `/usage monthly`, `/usage model monthly`, and the admin
  Models page surface discovered context windows, output limits, model
  capabilities, pricing, and per-model monthly spend where provider metadata is
  available.
- Anthropic can run through the direct Messages API with `ANTHROPIC_API_KEY`
  or through the official Claude CLI transport in host sandbox mode.
- Brave, Perplexity, and Tavily web-search credentials can live in the
  encrypted runtime secret store and are passed into host or container agent
  runtimes from the active config.
- Web search can also target a self-hosted SearXNG instance through
  `web.search.searxngBaseUrl` or `SEARXNG_BASE_URL`; authenticated instances
  use store-backed SearXNG bearer SecretRefs, and agents can override the
  global SearXNG base URL and bearer SecretRef for tenant-specific search.
  Bundled `search.web`, `search.news`, and `search.images` skills prefer that
  sovereign search path.
- Google OAuth credentials for Workspace skills live in the encrypted runtime
  secret store; agent runtimes receive short-lived access tokens for `gog` and
  `gws` instead of long-lived refresh tokens.
- Canonical user and agent identities use stable lowercase IDs and DNS-style
  discovery records so A2A peers can resolve remote URLs and public keys.
- `hybridclaw secret route ...` and `/secret route ...` can attach stored
  secrets or Google OAuth access tokens to matching `http_request` URL
  prefixes, including Google Ads API calls.
- `HYBRIDAI_FALLBACK_CHAIN` can route auth and rate-limit provider failures to
  alternate models/providers with cooldowns before retrying the primary.
- Skills can be enabled or disabled globally or per channel from
  `hybridclaw skill enable|disable`, TUI `/skill config`, or the admin
  `Skills` page.
- Packaged skills can declare versioned manifests, capabilities, required
  credentials, supported channels, and per-agent autonomy policy.
- Bundled skills include API-backed Google Workspace workflows (`gog`, `gws`),
  Salesforce inspection, GitHub issue queue processing (`gh-issues`),
  monthly SaaS invoice harvesting (`download-platform-invoices`), Airtable,
  FastBill, Lexware Office, managed or self-hosted Firecrawl, Google Ads, GA4 reporting,
  HeyGen, Hermes3000 long-form writing, Fronius solar monitoring, Homematic
  HCU state/control planning, natural-language warehouse SQL
  (`warehouse-sql`), brand-voice drafting, speech transcription and language
  detection (`speech.transcribe`, `speech.detect-language`), validated
  diagram-as-code creation through `diagram`, and editable Excalidraw diagram
  creation.
- Native media tools generate images and videos through configured providers,
  persist the resulting artifacts, and expose the same capability through the
  bundled `image-generation`, `video-generation`, and `video.from-script`
  skills.
- Native audio transcription can route through configured local or provider
  backends, produce private transcript artifacts, and attach language,
  timestamp, speaker, duration, and cost metadata when available.
- Dynamic per-turn context such as current date, host, today's daily memory,
  session summary, and retrieved context is appended after the static system
  prompt so provider prefix caches can reuse the stable prompt prefix.
- Browser automation can use local persistent Playwright profiles, Camofox
  profiles, or Browser Use Cloud sessions with encrypted `BROWSER_USE_API_KEY`
  storage, usage metering, shared navigation guards, SecretRef-gated credential
  fills, and deny-by-default host allowlisting for Camofox stealth mode.
- The repo-shipped `brand-voice` plugin can flag, rewrite, or block final
  responses that violate configured voice rules before they reach users.
- Built-in office skills handle longer PDF creation flows cleanly: the bundled
  PDF creator wraps long lines, honors explicit `\n`, and adds pages
  automatically when reports or invoices spill past the first page.
- Built-in memory can stay standalone or layer with ByteRover, Mem0, Honcho,
  MemPalace, QMD, and GBrain plugins depending on whether you want
  local-first recall, hosted memory, or domain-specific retrieval.
- Optional OpenTelemetry tracing exports gateway and agent spans to OTLP
  backends and annotates structured logs with trace ids for cross-system
  correlation.

## How HybridClaw compares

| Capability | HybridClaw | OpenClaw | Hermes Agent |
| --- | --- | --- | --- |
| Self-hosted runtime | ✅ Gateway + sandboxed container runtime | ✅ Self-hosted gateway/runtime | ✅ Self-hosted gateway/runtime |
| Migration support | ✅ Imports from OpenClaw and Hermes | ❌ No comparable import path surfaced | ⚠️ Imports from OpenClaw only |
| Encrypted secrets | ✅ Encrypted store + SecretRefs | ⚠️ SecretRefs, not a built-in encrypted store | ⚠️ File-permission-based secret storage |
| Approvals / governance | ✅ Approvals, audit trails, sandbox, config history | ⚠️ Strong approvals/audit, less enterprise-governance framing | ⚠️ Strong approvals/isolation, less audit/admin surface |
| Memory / knowledge | ✅ Shared memory + HybridAI knowledge path | ⚠️ Strong memory/session features | ⚠️ Strong persistent/self-improving memory |
| Multi-agent observability | ✅ Built-in audit surfaces + platform path | ⚠️ Multi-agent/task inspection exists | ⚠️ Subagents + logs/session search, not central observability |
| Local + cloud deployment model | ✅ Local-first runtime with HybridAI cloud path plus SSH/Tailscale remote access | ⚠️ Self-hosted + remote access | ✅ Local, VPS, Docker, Modal, Daytona |
| Multiple UIs | ✅ TUI + Chat UI + Admin UI + Agents UI | ✅ TUI + WebChat + Control UI | ⚠️ TUI + messaging + API server, no comparable built-in admin/chat web UI |

## Adjacent tools

| Comparison point | HybridClaw | LangChain | n8n |
| --- | --- | --- | --- |
| Framework vs runtime | Runtime | Framework | Workflow builder |
| Coding required | Low to medium | High | Low |
| Workflow builder vs agent runtime | Agent runtime | Framework for building agent systems | Visual workflow builder |
| Enterprise controls | ✅ Approvals, audit, sandbox, encrypted secrets | ⚠️ You build them | ⚠️ Workflow-level controls |

## Security and governance built in

- secure credential storage
- optional confidential-info redaction before model calls
- retroactive audit leak scanning
- sandboxed execution
- approvals
- audit trails with hash chain
- config versioning and backup/rollback
- observability

## Built for real workflows

- channels
- versioned agent workspace prompt files with saved revisions and restore
- browser sessions
- office docs
- skills / plugins / MCP
- persistent workspaces

## Built for rollout and migration

- import from OpenClaw / Hermes
- portable `.claw` packages with bundled knowledge and skills
- local-first to cloud-ready path

## Architecture

- **Gateway service** (Node.js) — shared message/command handlers, SQLite persistence (KV + semantic + knowledge graph + canonical sessions + usage events), scheduler, heartbeat, web/API, loopback OpenAI-compatible API, A2A peer trust, board-card storage, and channel integrations for Discord, Discord Incoming Webhooks, Slack, Slack Incoming Webhooks, Signal, Threema, Microsoft Teams, Telegram, iMessage, WhatsApp, Twilio voice, and email
- **TUI client** — thin client over HTTP (`/api/chat`, `/api/command`) with
  a structured startup banner that surfaces model, sandbox, gateway, and
  chatbot context before the first prompt, live delegate status/progress,
  an interactive approval picker for pending approvals, and an exit summary
  with a ready-to-run resume command
- **Container** (Docker, ephemeral) — HybridAI API client, sandboxed tool executor, native media-generation tools, web/search adapters, and preinstalled browser automation runtime with cursor-aware snapshots for JS-heavy custom UI
- Communication via file-based IPC (input.json / output.json)

## Documentation

Browse the full manual at
[hybridaione.github.io/hybridclaw/docs](https://hybridaione.github.io/hybridclaw/docs/).

- Getting started:
  [Installation](https://hybridaione.github.io/hybridclaw/docs/getting-started/installation),
  [Authentication](https://hybridaione.github.io/hybridclaw/docs/getting-started/authentication), and
  [Quick Start](https://hybridaione.github.io/hybridclaw/docs/getting-started/quickstart)
- Enterprise deployment:
  [Runtime Internals](https://hybridaione.github.io/hybridclaw/docs/developer-guide/runtime) and
  [Architecture](https://hybridaione.github.io/hybridclaw/docs/developer-guide/architecture)
- Operations:
  [Remote Access](https://hybridaione.github.io/hybridclaw/docs/guides/remote-access)
- Security:
  [SECURITY.md](./SECURITY.md) and [TRUST_MODEL.md](./TRUST_MODEL.md)
- Migration:
  [Commands: Migration](https://hybridaione.github.io/hybridclaw/docs/reference/commands#migration) and
  [FAQ](https://hybridaione.github.io/hybridclaw/docs/reference/faq#can-i-migrate-an-existing-openclaw-or-hermes-agent-home)
- Channels:
  [Connect Your First Channel](https://hybridaione.github.io/hybridclaw/docs/getting-started/first-channel),
  [Overview](https://hybridaione.github.io/hybridclaw/docs/channels/overview),
  [Twilio Voice](https://hybridaione.github.io/hybridclaw/docs/guides/twilio-voice),
  [Discord](https://hybridaione.github.io/hybridclaw/docs/channels/discord),
  [Discord Incoming Webhook](https://hybridaione.github.io/hybridclaw/docs/channels/discord-webhook),
  [Slack](https://hybridaione.github.io/hybridclaw/docs/channels/slack),
  [Slack Incoming Webhook](https://hybridaione.github.io/hybridclaw/docs/channels/slack-webhook),
  [Telegram](https://hybridaione.github.io/hybridclaw/docs/channels/telegram),
  [Signal](https://hybridaione.github.io/hybridclaw/docs/channels/signal),
  [Threema](https://hybridaione.github.io/hybridclaw/docs/channels/threema),
  [Email](https://hybridaione.github.io/hybridclaw/docs/channels/email),
  [WhatsApp](https://hybridaione.github.io/hybridclaw/docs/channels/whatsapp),
  [iMessage](https://hybridaione.github.io/hybridclaw/docs/channels/imessage), and
  [Microsoft Teams](https://hybridaione.github.io/hybridclaw/docs/channels/msteams)
- Tutorials:
  [Practical Workflows](https://hybridaione.github.io/hybridclaw/docs/tutorials) for owner,
  GTM, marketing, sales, DevRel, content, invoicing, webinar, and release
  launch workflows
- Skills and plugins:
  [Extensibility](https://hybridaione.github.io/hybridclaw/docs/extensibility),
  [Bundled Skills](https://hybridaione.github.io/hybridclaw/docs/guides/bundled-skills),
  [Plugin System](https://hybridaione.github.io/hybridclaw/docs/extensibility/plugins),
  [Memory Plugins](https://hybridaione.github.io/hybridclaw/docs/extensibility/memory-plugins),
  [ByteRover Memory Plugin](https://hybridaione.github.io/hybridclaw/docs/extensibility/byterover-memory-plugin),
  [GBrain Plugin](https://hybridaione.github.io/hybridclaw/docs/extensibility/gbrain-plugin),
  [Mem0 Memory Plugin](https://hybridaione.github.io/hybridclaw/docs/extensibility/mem0-memory-plugin),
  [Honcho Memory Plugin](https://hybridaione.github.io/hybridclaw/docs/extensibility/honcho-memory-plugin), and
  [MemPalace Memory Plugin](https://hybridaione.github.io/hybridclaw/docs/extensibility/mempalace-memory-plugin)
- Configuration:
  [Configuration Reference](https://hybridaione.github.io/hybridclaw/docs/reference/configuration)
- CLI reference:
  [Commands](https://hybridaione.github.io/hybridclaw/docs/reference/commands),
  [Diagnostics](https://hybridaione.github.io/hybridclaw/docs/reference/diagnostics), and
  [FAQ](https://hybridaione.github.io/hybridclaw/docs/reference/faq)

## Contributing

Contributor quick start:

```bash
npm install
npm run setup
npm run build
npm run typecheck
npm run test:unit
```

Use `npm run typecheck`, `npm run lint`, and targeted tests for code changes.
For docs-only changes, verify links, commands, and examples. GitHub issue forms
cover bug reports, setup help, feature requests, and docs fixes, and the PR
template asks for validation and scope boundaries up front. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow, check matrix, and
community guidance.

## Community

- Discord: [discord.gg/jsVW4vJw27](https://discord.gg/jsVW4vJw27)
- Issues: [github.com/HybridAIOne/hybridclaw/issues](https://github.com/HybridAIOne/hybridclaw/issues)
- Discussions: [github.com/HybridAIOne/hybridclaw/discussions](https://github.com/HybridAIOne/hybridclaw/discussions)
- Support guide: [SUPPORT.md](./SUPPORT.md)
- Community standards: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
