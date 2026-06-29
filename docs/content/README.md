---
title: HybridClaw Docs
description: User, operator, and developer documentation for HybridClaw installation, channels, workflows, extensibility, and runtime internals.
sidebar_position: 1
---

# HybridClaw Docs

Welcome to the HybridClaw handbook — the operator, contributor, and
advanced-user manual for running, extending, and understanding HybridClaw. The
chapters are organized around what you are trying to do rather than how the
repository is laid out. **Getting Started** walks through installation,
onboarding, and your first run. **Channels** is the transport reference across
Discord, Slack, Telegram, Signal, Threema, email, WhatsApp, iMessage, and
Microsoft Teams.
**Guides** collects task-focused walkthroughs for everyday operational work,
**Tutorials** provides practical owner, GTM, marketing, sales, and community
workflows, **Extensibility** covers tools, skills, plugins, and the extension
architecture, and the **Developer Guide** goes deeper into architecture and
maintainer-facing internals. When you just need a fact — a command, a config
key, a diagnostic — **Reference** is the place to land.

Every page in the browser docs shell keeps its raw `.md` source one click
away: open it directly from the header, or copy the full page markdown for
sharing and quoting. If you prefer a single markdown index that links every
doc at once, start from [For Agents](./agents.md).

## Latest Highlights

- HybridClaw v0.25.8 uses configured public deployment URLs for cloud MCP OAuth
  callbacks, admin origin checks, and mobile chat QR links when requests arrive
  through internal hosts.
- HybridClaw v0.25.8 autosaves default email allowed-sender additions as soon
  as admins click Add.
- Email channel advanced settings are collapsed by default so additional
  mailboxes stay easier to scan while lower-frequency options remain available.
- HybridClaw v0.25.7 uses a conversational first-run hatching flow with a
  natural email ask for the welcome note and shorter setup prompts.
- Web chat keeps new no-user drafts concrete, prunes older empty or
  assistant-only drafts, and preserves sessions that already have user
  messages.
- Admin channel settings expose sender allowlist editors for WhatsApp,
  Telegram, Threema, Signal, email, Microsoft Teams, Slack, and iMessage, with
  wildcard confirmation for all-sender entries.
- Gateway session timestamps render in the local timezone without seconds or a
  UTC suffix.
- Doctor resource hygiene reports stale histories with no user messages as
  unstarted sessions and can clean up those empty or assistant-only rows.
- The bundled Langfuse skill covers LLM observability and evaluation workflows
  through guarded gateway-proxied tools.
- The Apple desktop wrapper records gateway startup logs and recent child
  output so packaged app launch failures are easier to diagnose.
- A2A Agent Cards advertise the configured public deployment URL and fail closed
  when that URL is invalid.
- Dependency maintenance remediates npm audit findings, upgrades Nodemailer to
  9.0.0, and documents the lockfile update workflow.
- MCP startup tolerates one failing server without aborting the whole chat turn,
  and workspace bootstrap skips empty heartbeat defaults.
- First-run hatching can use a
  dedicated model, keeps setup links visible in chat, records first-job ideas,
  sends the welcome email when an email route is available, and avoids duplicate
  bootstrap starts.
- Remote MCP servers can use gateway-managed OAuth 2.1 with guided setup in
  the TUI and web console, encrypted token storage, automatic refresh, and
  `/mcp login|logout|status` commands.
- Admin skill detail pages show docs, prompts, dependencies, logos, credential
  status, recent invocations, enable controls, example prompt launchers, and a
  guarded package text-file editor.
- Built-in email supports per-agent mailboxes through `email.accounts[]`, so
  inbound threads and outbound replies stay tied to the right agent address.
- The `agent-risk` eval gate covers top-level NIST AI RMF, NIST AI 600-1, and
  OWASP LLM Top 10 2025 scenarios with redacted evidence artifacts.
- Admin RBAC role bundles, route-level scoped action enforcement, ISO/IEC
  27001 evidence docs, ISO/IEC 42001 readiness docs, SBOM/provenance
  attestations, CodeQL, and secret scanning improve governance evidence.
- The bundled `posthog` business skill covers guarded event capture,
  person-property updates, feature flag reads/tests, and HogQL reads.
- `sessions prune --older-than <duration>` gives operators an auditable,
  dry-run-first way to clean old persisted session history.
- HybridAI Cloud launches hosted HybridClaw environments from
  [hybridclaw.io](https://hybridclaw.io) when teams want the fastest managed
  path instead of preparing local infrastructure first.
- Multi-agent workflows span local agents, hosted HybridAI proxy agents, and
  trusted peer HybridClaw instances through explicit addressing, A2A pairing,
  inbound envelopes, and admin-visible trust.
- Encrypted runtime secrets and SecretRefs keep raw credentials out of model
  context; tools receive scoped credential material at execution time instead
  of asking the LLM to handle API keys or passwords.
- Native `image_generate` and `video_generate` tools produce managed media
  artifacts through configured image and video providers.
- Bundled skills cover Airtable, FastBill, Firecrawl, Fronius, HeyGen,
  Homematic, Google Ads, and SearXNG-backed web/news/image search workflows.
- Threema Gateway Basic mode is available for outbound operator messaging in
  DACH-regulated or privacy-sensitive deployments.
- A2A federation includes JSON-RPC Agent Card inbound delivery, signed
  delegation bearer tokens, operator pairing, and a public-key trust ledger.
- Human distillation turns consented source material into cited coworker-agent
  personas with reversible merges, leakage/fidelity evals, and multi-host
  export bundles.
- Named local endpoints let operators run multiple Ollama, LM Studio,
  llama.cpp, or vLLM servers side by side, including Qwen and Gemma behavior
  hints for local models.
- HybridAI proxy agents forward selected agents to hosted HybridAI chatbots
  while keeping gateway channel routing and SecretRef-backed upstream auth.
- Browser automation supports local Playwright profiles, Camofox profiles, and
  Browser Use Cloud sessions with SecretRef-gated credential fills.
- Trace-judge eval gates and behavioral anomaly reranking give tool-call and
  skill-trace review a deterministic test path.
- Harness evolution runs eval-driven coworker workspace improvement loops with
  F12 manifests, seed-delta reporting, and admin inspection.
- `/second-opinion` compares or validates answers with a stronger configured
  model while honoring confidentiality, context, and agent-budget limits.
- Web chat renders slash-command results distinctly and records persisted
  thumbs-up/down response ratings for observability and Adaptive Skills.
- `npm run desktop` launches a native macOS wrapper around the local chat UI,
  with gateway reuse/startup and admin access from the app menu.
- Canonical user and agent identity helpers now include DNS-style discovery for
  mapping remote identities to peer URLs and public keys.
- Approval policy evaluation runs through a hook-fed rule pipeline that keeps
  built-in trust behavior while allowing explicit policy ordering and plugin
  visibility.
- Web chat session history and active-agent switching are more stable across
  route changes and resumed sessions.
- The `download-platform-invoices` skill harvests official monthly SaaS
  invoice PDFs and normalized records across billing APIs, browser-backed
  portals, Google Ads, cloud providers, and DATEV handoff flows.
- The `warehouse-sql` skill reviews and runs read-only natural-language SQL
  against cached warehouse schemas.
- The `mailchimp` skill covers Mailchimp Marketing audiences, campaigns,
  reports, automations, journeys, and Transactional/Mandrill sends with
  approval-gated writes.
- Signal joins the channel catalog with a full `signal-cli` daemon setup guide,
  private-by-default DM policy, group controls, and admin QR linking.
- `.confidential.yml` rules can redact NDA-class business data before model
  calls, while `hybridclaw audit scan-leaks` scans historical audit logs for
  possible leaks.
- Web chat shows live context-window usage, supports `/context`, searches
  recent sessions, and can switch the active agent from the composer.
- The admin console includes statistics and agent-scoreboard pages for
  sessions, messages, tokens, cost trends, skill scores, reliability, timing,
  and CV links.
- Packaged business skills can declare manifests, capabilities, required
  credentials, supported channels, lifecycle snapshots, and rollback history.
- Deployment config can describe cloud/local mode and tunnel provider intent;
  the built-in ngrok, Tailscale, and Cloudflare providers read runtime auth
  secrets from encrypted storage.
- `HYBRIDAI_FALLBACK_CHAIN` can route auth and rate-limit provider failures to
  alternate models/providers with primary-provider cooldowns.
- Model info, usage summaries, and the admin Models page surface discovered
  context windows, output limits, capabilities, pricing, and monthly spend
  where providers expose the metadata.
- Installation options include npm, source checkout, a multi-arch Nix flake,
  a NixOS module, and a preview Homebrew formula for `--HEAD` builds.

## Browse By Section

- [Manifesto](./manifesto.md) — the product principles HybridClaw is built around: what we will and will not ship
- [Getting Started](./getting-started/README.md) for installation,
  onboarding, provider authentication, and connecting the first transport
- [Channels](./channels/README.md) for the full supported channel catalog and
  transport-specific setup details
- [Guides](./guides/README.md) for local providers, MCP, bundled skills,
  remote access, voice/TTS, and optional office tooling
- [Tutorials](./tutorials/README.md) for practical owner, GTM, marketing,
  sales, and community workflows
- [Extensibility](./extensibility/README.md) for tools, skills, plugins,
  agent packages, and extension-specific operator workflows
- [Developer Guide](./developer-guide/README.md) for architecture, runtime
  behavior, session routing, testing, and release mechanics
- [Reference](./reference/README.md) for model selection, configuration,
  diagnostics, commands, and FAQ

## Fast Paths

- Want the fastest managed launch? Start at
  [hybridclaw.io](https://hybridclaw.io).
- Need to install HybridClaw quickly? Go to
  [Installation](./getting-started/installation.md).
- Need the shortest path to a running gateway and chat UI? Go to
  [Quick Start](./getting-started/quickstart.md).
- Need to connect one transport without reading the full channel manual? Go to
  [Connect Your First Channel](./getting-started/first-channel.md).
- Need command lookup or troubleshooting help? Go to
  [Commands](./reference/commands.md) and
  [Diagnostics](./reference/diagnostics.md).
- Need setup answers before deploying? Go to [FAQ](./reference/faq.md).
- Need to reach `/chat`, `/agents`, or `/admin` from another machine? Go to
  [Remote Access](./guides/remote-access.md).
- Need one markdown page that links the whole docs tree? Go to
  [For Agents](./agents.md).
