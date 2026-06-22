# HybridClaw

[![CI](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/HybridAIOne/hybridclaw/gh-pages/badge/coverage.json)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hybridaione/hybridclaw)](https://www.npmjs.com/package/@hybridaione/hybridclaw)
[![Node](https://img.shields.io/badge/node-22.x-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/en/download)
[![License](https://img.shields.io/github/license/HybridAIOne/hybridclaw)](https://github.com/HybridAIOne/hybridclaw/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://hybridaione.github.io/hybridclaw/docs/)
[![Powered by HybridAI](https://img.shields.io/badge/powered%20by-HybridAI-blueviolet)](https://hybridai.one)
[![Cloud](https://img.shields.io/badge/cloud-launch%20HybridClaw-2ea44f)](https://hybridclaw.io)
[![Discord](https://img.shields.io/badge/Discord-join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/jsVW4vJw27)

<img width="420" height="397" alt="HybridClaw - Enterprise-ready self-hosted AI assistant runtime" src="docs/hero.png" />

## Business Skills That Work On Smaller Models

HybridClaw's main promise is practical business work. The bundled CRM,
marketing, analytics, finance, cloud, office, and operations skills are
implemented as tested helpers with eval scenarios, credential boundaries, and
approval tiers, and are validated against `Qwen/Qwen3.6-27B-FP8` as the
small-model baseline.

That is the useful difference: a compact model can operate Salesforce,
HubSpot, GA4, Google Ads, Lexware, Airtable, warehouse SQL, invoices, cloud
ops, and office documents through structured rails instead of fragile
free-form prompting.

HybridClaw also treats agents as networked coworkers. Local agents, hosted
HybridAI proxy agents, and trusted peer HybridClaw instances can address one
another, exchange A2A envelopes, and route work through approval-aware
channels.

First-run onboarding is built around hatching: a new agent asks about the
user's work, records useful context, keeps setup links visible in chat, and can
send a tailored first-jobs welcome email when an email route is available.

Credentials stay outside the model context. Secrets live in the encrypted
runtime store and SecretRef-backed tools resolve them at execution time, so
LLMs see the requested action and approval context, not raw API keys,
passwords, or bearer tokens.

Run one local assistant, operate a fleet of role-specific coworkers, or launch
HybridClaw on HybridAI Cloud in a few minutes at
[hybridclaw.io](https://hybridclaw.io).

[Quick Start](https://hybridaione.github.io/hybridclaw/docs/getting-started/quickstart) ·
[Launch Cloud](https://hybridclaw.io) ·
[Installation](https://hybridaione.github.io/hybridclaw/docs/getting-started/installation) ·
[Docs](https://hybridaione.github.io/hybridclaw/docs/) ·
[Configuration](https://hybridaione.github.io/hybridclaw/docs/reference/configuration) ·
[Commands](https://hybridaione.github.io/hybridclaw/docs/reference/commands) ·
[Contributing](./CONTRIBUTING.md)

## Why HybridClaw

| You need | HybridClaw gives you |
| --- | --- |
| A first run that becomes useful quickly | Guided hatching with setup links, tailored first-job suggestions, optional onboarding-specific model routing, and welcome-email handoff |
| Business workflows that survive real use | Production skill helpers with fixtures, eval scenarios, targeted tests, approval tiers, and a `Qwen/Qwen3.6-27B-FP8` validation baseline |
| Multi-agent workflows across installations | Local agents, hosted proxy agents, A2A trust, explicit addressing, inbound envelopes, and admin-visible peer pairing |
| Credentials the model cannot read | Encrypted runtime secrets and SecretRef-backed execution paths that keep raw keys and passwords out of prompts and tool results |
| Assistants that can act, not just chat | A gateway, web chat, TUI, admin console, scheduler, tools, and OpenAI-compatible API behind one local service |
| Control over sensitive work | Approval policy, sandbox boundaries, output guardrails, and hash-chained audit trails |
| Agents that fit existing teams | Discord, Slack, Teams, Telegram, WhatsApp, email, voice, web, and more through the same runtime |
| Operational memory | Local files, SQLite state, semantic recall, session compaction, and optional HybridAI cloud memory |
| Repeatable expert workflows | Per-agent workspaces, budgets, model routing, A2A trust, proxy agents, `.claw` archives, and human-distillation workflows |

## Install

Fastest managed launch: [HybridClaw on HybridAI Cloud](https://hybridclaw.io).

Apple Desktop App for macOS:

- Download the signed and notarized Apple Silicon DMG from
  [GitHub Releases](https://github.com/HybridAIOne/hybridclaw/releases/latest).
- Open the DMG, drag `HybridClaw.app` into `/Applications`, and launch it.
- The desktop app starts the local gateway and opens the chat, agents, and
  admin surfaces in a native macOS window.

Linux/macOS CLI one-line installer:

```bash
curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash
```

Manual npm install:

```bash
npm install -g @hybridaione/hybridclaw
hybridclaw onboarding
hybridclaw gateway
hybridclaw tui
```

Requirements: Node.js 22. Docker is recommended for the default sandbox.

## First Run

After the gateway starts, open:

| Surface | URL / command | Use it for |
| --- | --- | --- |
| Web Chat | `http://127.0.0.1:9090/chat` | Chat, slash commands, model and agent switching |
| Admin Console | `http://127.0.0.1:9090/admin` | Channels, agents, approvals, audit, config, secrets, skills, distillation |
| Agents UI | `http://127.0.0.1:9090/agents` | Agent fleet overview and prompt-file editing |
| TUI | `hybridclaw tui` | Terminal chat, approvals, status, resume |
| OpenAI-compatible API | `http://127.0.0.1:9090/v1/chat/completions` | Local evals and compatible clients |

For signed macOS desktop builds and future architectures, use the
[GitHub Releases](https://github.com/HybridAIOne/hybridclaw/releases/latest)
page.

Desktop wrapper from source:

```bash
npm install
npm run desktop
```

## What You Get

| Area | Built in |
| --- | --- |
| Skills | 76 bundled skills, production business helpers, eval fixtures, packaged skill lifecycle, and human-distillation workflows |
| Channels | Discord, Slack, Signal, WhatsApp, Telegram, Microsoft Teams, email, iMessage, fax, Twilio voice, web, and incoming webhooks |
| Runtime | Gateway service, TUI client, web chat, admin console, loopback OpenAI-compatible API, Docker or host execution |
| Governance | Encrypted runtime secrets, SecretRef credential isolation, approval policies, sandbox controls, audit trails with hash-chain integrity |
| Memory | Local memory files, SQLite persistence, semantic recall, session compaction, optional HybridAI cloud memory sync |
| Agents | Guided hatching, per-agent workspaces, models, budgets, prompt files, explicit addressing, proxy agents, A2A trust, peer-instance communication |
| Extensibility | Packaged business skills, plugins, MCP servers, SecretRef-backed HTTP tools |

## Product Strengths

- **Validated business skills**: production skills use deterministic helpers,
  fixtures, eval scenarios, and targeted tests so small models can perform
  useful work through structured actions.
- **Guided onboarding**: hatching collects useful work context, keeps setup
  links handy, writes first-job suggestions, and can route the first-run
  conversation through a stronger onboarding model before returning to the
  normal default.
- **Multi-agent operations**: agents can coordinate across local workspaces,
  hosted HybridAI proxies, and trusted peer HybridClaw instances with A2A
  pairing, explicit addressing, inbound envelopes, and admin-visible trust.
- **Prompt-level credential isolation**: encrypted secrets and SecretRefs keep
  credential values out of model context while tools receive only the scoped
  credential material needed at execution time.
- **One runtime for many surfaces**: web, terminal, Discord, Slack, Teams,
  email, voice, webhooks, and local API clients all use the same gateway,
  memory, policy, and audit model.
- **Secure by default**: LLM output is treated as untrusted, risky actions
  route through approval policy, and every sensitive boundary is visible in
  audit.
- **Model freedom**: use HybridAI, major hosted providers, local engines, or
  named OpenAI-compatible endpoints from the same model picker and config
  surface.
- **Operator visibility**: `/admin` covers channels, approvals, audit,
  statistics, output guard, secrets, fleet topology, A2A inbox/trust, and
  distillation without requiring shell access.
- **Business-ready extension model**: packaged skills, plugins, MCP servers,
  and SecretRef-backed HTTP tools share the same approval and credential
  boundaries.
- **Practical migration path**: preview compatible imports from OpenClaw or
  Hermes, then package agents as portable `.claw` archives.

## Common Commands

```bash
hybridclaw gateway status
hybridclaw tui --resume <sessionId>
hybridclaw config get <key>
hybridclaw skill list
hybridclaw agent list
hybridclaw doctor
hybridclaw update --yes
```

Migration preview:

```bash
hybridclaw migrate openclaw --dry-run
hybridclaw migrate hermes --dry-run
```

## HybridAI Platform

HybridClaw runs self-hosted. HybridAI is the optional platform layer around it:

- managed HybridClaw launch at [hybridclaw.io](https://hybridclaw.io)
- enterprise shared RAG and cloud memory
- managed access to current models
- observability across multiple agents
- hosted email addresses for agents
- ready-to-run virtual coworkers

## Architecture

```text
User message
  -> Gateway (HTTP, web chat, TUI, Discord, Slack, email, etc.)
  -> ContainerInput JSON
  -> Host or Docker runtime
  -> Agent loop, tools, approvals, memory, MCP
  -> ContainerOutput JSON
  -> Gateway response, session store, audit trail
```

Core pieces:

- **Gateway service**: command handling, channel transports, REST APIs,
  scheduler, SQLite persistence, audit, A2A, admin surfaces.
- **Container runtime**: sandboxed tool execution, provider adapters, browser
  automation, media/search tooling, file-based IPC.
- **TUI client**: thin HTTP client for terminal-first operation.
- **Console**: web chat and admin UI served by the gateway.

## Docs By Goal

| Goal | Start here |
| --- | --- |
| Install and launch | [Quick Start](https://hybridaione.github.io/hybridclaw/docs/getting-started/quickstart), [Installation](https://hybridaione.github.io/hybridclaw/docs/getting-started/installation) |
| Configure providers and models | [Authentication](https://hybridaione.github.io/hybridclaw/docs/getting-started/authentication), [Model Selection](https://hybridaione.github.io/hybridclaw/docs/reference/model-selection) |
| Connect channels | [Connect Your First Channel](https://hybridaione.github.io/hybridclaw/docs/getting-started/first-channel), [Channels](https://hybridaione.github.io/hybridclaw/docs/channels/overview) |
| Use bundled skills | [Bundled Skills](https://hybridaione.github.io/hybridclaw/docs/guides/bundled-skills), [Skills Catalog](https://hybridaione.github.io/hybridclaw/docs/guides/skills/) |
| Distill a coworker | [Human Distillation](https://hybridaione.github.io/hybridclaw/docs/guides/human-distillation) |
| Operate securely | [Security](./SECURITY.md), [Trust Model](./TRUST_MODEL.md), [Approvals](https://hybridaione.github.io/hybridclaw/docs/developer-guide/approvals) |
| Inspect commands | [Commands](https://hybridaione.github.io/hybridclaw/docs/reference/commands), [Diagnostics](https://hybridaione.github.io/hybridclaw/docs/reference/diagnostics) |
| Extend HybridClaw | [Extensibility](https://hybridaione.github.io/hybridclaw/docs/extensibility), [Plugins](https://hybridaione.github.io/hybridclaw/docs/extensibility/plugins), [MCP](https://hybridaione.github.io/hybridclaw/docs/guides/tui-mcp) |
| Build desktop releases | [Desktop Release Builds](https://hybridaione.github.io/hybridclaw/docs/developer-guide/desktop-release) |
| Contribute | [CONTRIBUTING.md](./CONTRIBUTING.md), [docs/content/README.md](./docs/content/README.md) |

Latest release: [v0.25.4](https://github.com/HybridAIOne/hybridclaw/releases/tag/v0.25.4).
Release notes: [CHANGELOG.md](./CHANGELOG.md)

## Development

```bash
npm install
npm run setup
npm run build
npm run typecheck
npm run test:unit
```

Useful dev commands:

```bash
npm run dev          # gateway in hot-reload mode
npm run tui          # terminal client
npm run check        # Biome check
npm run format       # Biome write
```

For docs-only changes, verify links, commands, and examples. For code changes,
run `npm run typecheck`, `npm run lint`, and targeted tests for the touched
area.

## Community

- Discord: [discord.gg/jsVW4vJw27](https://discord.gg/jsVW4vJw27)
- Issues: [github.com/HybridAIOne/hybridclaw/issues](https://github.com/HybridAIOne/hybridclaw/issues)
- Discussions: [github.com/HybridAIOne/hybridclaw/discussions](https://github.com/HybridAIOne/hybridclaw/discussions)
- Support guide: [SUPPORT.md](./SUPPORT.md)
- Community standards: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
