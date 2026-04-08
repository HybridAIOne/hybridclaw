# HybridClaw

[![CI](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/HybridAIOne/hybridclaw/gh-pages/badge/coverage.json)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hybridaione/hybridclaw)](https://www.npmjs.com/package/@hybridaione/hybridclaw)
[![Node](https://img.shields.io/badge/node-22.x-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/en/download)
[![License](https://img.shields.io/github/license/HybridAIOne/hybridclaw)](https://github.com/HybridAIOne/hybridclaw/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-hybridclaw.io-blue)](https://www.hybridclaw.io/docs/)
[![Powered by HybridAI](https://img.shields.io/badge/powered%20by-HybridAI-blueviolet)](https://hybridai.one)
[![Discord](https://img.shields.io/badge/Discord-join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/jsVW4vJw27)

<img width="420" height="397" alt="HybridClaw - The enterprise operating layer for open agents" src="docs/hero.png" />

## The enterprise operating layer for open agents.

Self-hosted, controllable, and built for real business workflows.

Most open agent stacks are optimized for experimentation and breadth.

HybridClaw is optimized for enterprise deployment:
- controlled execution
- shared knowledge
- observability
- repeatable workflows
- local-first deployment

## HybridAI Platform Advantage

HybridClaw is the runtime. HybridAI is the platform layer around it.

HybridAI adds:

- one-click cloud deployment
- enterprise shared RAG / knowledge
- access to current models from Anthropic, OpenAI, Google, xAI, and others
- observability across multiple agents

## Get running in 2 minutes

```bash
npm install -g @hybridaione/hybridclaw
hybridclaw onboarding
hybridclaw gateway
hybridclaw tui
```

Open locally:

- Chat UI: `http://127.0.0.1:9090/chat`
- Admin UI: `http://127.0.0.1:9090/admin`
- Agents UI: `http://127.0.0.1:9090/agents`

Requirement: Node.js 22 (Docker recommended for sandbox)

Release notes live in [CHANGELOG.md](./CHANGELOG.md), and the browsable
operator and maintainer manual lives at
[hybridclaw.io/docs](https://www.hybridclaw.io/docs/).

## Coming from OpenClaw or Hermes?

```bash
hybridclaw migrate openclaw --dry-run
hybridclaw migrate hermes --dry-run
```

Preview and import compatible state from OpenClaw or Hermes in minutes.
Imports compatible skills, memory, config, and optional secrets.

## See it in Action

Once the gateway is running, open HybridClaw locally:

- Web Chat: `http://127.0.0.1:9090/chat`
- Admin Console: `http://127.0.0.1:9090/admin`
- Agent Dashboard: `http://127.0.0.1:9090/agents`

## How HybridClaw compares

| Capability | HybridClaw | OpenClaw | Hermes Agent |
| --- | --- | --- | --- |
| Self-hosted runtime | ✅ Gateway + sandboxed container runtime | ✅ Self-hosted gateway/runtime | ✅ Self-hosted gateway/runtime |
| Migration support | ✅ Imports from OpenClaw and Hermes | ❌ No comparable import path surfaced | ⚠️ Imports from OpenClaw only |
| Encrypted secrets | ✅ Encrypted store + SecretRefs | ⚠️ SecretRefs, not a built-in encrypted store | ⚠️ File-permission-based secret storage |
| Approvals / governance | ✅ Approvals, audit trails, sandbox, config history | ⚠️ Strong approvals/audit, less enterprise-governance framing | ⚠️ Strong approvals/isolation, less audit/admin surface |
| Memory / knowledge | ✅ Shared memory + HybridAI knowledge path | ⚠️ Strong memory/session features | ⚠️ Strong persistent/self-improving memory |
| Multi-agent observability | ✅ Built-in audit surfaces + platform path | ⚠️ Multi-agent/task inspection exists | ⚠️ Subagents + logs/session search, not central observability |
| Local + cloud deployment model | ✅ Local-first runtime with HybridAI cloud path | ⚠️ Self-hosted + remote access | ✅ Local, VPS, Docker, Modal, Daytona |
| Multiple UIs | ✅ TUI + Chat UI + Admin UI + Agents UI | ✅ TUI + WebChat + Control UI | ⚠️ TUI + messaging + API server, no comparable built-in admin/chat web UI |

## Adjacent tools

| Comparison point | HybridClaw | LangChain | n8n |
| --- | --- | --- | --- |
| Framework vs runtime | Runtime | Framework | Workflow builder |
| Coding required | Low to medium | High | Low |
| Workflow builder vs agent runtime | Agent runtime | Framework for building agent systems | Visual workflow builder |
| Enterprise controls | ✅ Approvals, audit, sandbox, encrypted secrets | ⚠️ You build them | ⚠️ Workflow-level controls |

## Built for enterprise operations

- encrypted secrets
- approvals
- audit trails
- config versioning
- observability

## Built for real workflows

- channels
- browser sessions
- office docs
- skills / plugins / MCP
- persistent workspaces

## Built for rollout and migration

- import from OpenClaw / Hermes
- portable `.claw` packages
- local-first to cloud-ready path

## Architecture

- **Gateway service** (Node.js) — shared message/command handlers, SQLite persistence (KV + semantic + knowledge graph + canonical sessions + usage events), scheduler, heartbeat, web/API, loopback OpenAI-compatible API, and channel integrations for Discord, Microsoft Teams, iMessage, WhatsApp, and email
- **TUI client** — thin client over HTTP (`/api/chat`, `/api/command`) with
  a structured startup banner that surfaces model, sandbox, gateway, and
  chatbot context before the first prompt
- **Container** (Docker, ephemeral) — HybridAI API client, sandboxed tool executor, and preinstalled browser automation runtime with cursor-aware snapshots for JS-heavy custom UI
- Communication via file-based IPC (input.json / output.json)

## Documentation

Browse the full manual at
[hybridclaw.io/docs](https://www.hybridclaw.io/docs/).

- Getting started:
  [Installation](https://www.hybridclaw.io/docs/development/getting-started/installation),
  [Authentication](https://www.hybridclaw.io/docs/development/getting-started/authentication), and
  [Quick Start](https://www.hybridclaw.io/docs/development/getting-started/quickstart)
- Enterprise deployment:
  [Runtime Internals](https://www.hybridclaw.io/docs/development/internals/runtime) and
  [Architecture](https://www.hybridclaw.io/docs/development/internals/architecture)
- Security:
  [SECURITY.md](./SECURITY.md) and [TRUST_MODEL.md](./TRUST_MODEL.md)
- Migration:
  [Commands: Migration](https://www.hybridclaw.io/docs/development/reference/commands#migration) and
  [FAQ](https://www.hybridclaw.io/docs/development/reference/faq#can-i-migrate-an-existing-openclaw-or-hermes-agent-home)
- Channels:
  [Channel Setup](https://www.hybridclaw.io/docs/development/getting-started/channels),
  [iMessage](https://www.hybridclaw.io/docs/imessage), and
  [MS Teams](https://www.hybridclaw.io/docs/msteams)
- Skills and plugins:
  [Extensibility](https://www.hybridclaw.io/docs/development/extensibility),
  [Bundled Skills](https://www.hybridclaw.io/docs/development/guides/bundled-skills), and
  [Plugin System](https://www.hybridclaw.io/docs/development/extensibility/plugins)
- Configuration:
  [Configuration Reference](https://www.hybridclaw.io/docs/development/reference/configuration)
- CLI reference:
  [Commands](https://www.hybridclaw.io/docs/development/reference/commands),
  [Diagnostics](https://www.hybridclaw.io/docs/development/reference/diagnostics), and
  [FAQ](https://www.hybridclaw.io/docs/development/reference/faq)

## Contributing

Mini quick start:

```bash
npm install
npm run setup
npm run build
```

Use `npm run typecheck`, `npm run lint`, and targeted tests for code changes.
For docs-only changes, verify links, commands, and examples. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow and check matrix.

## Community

- Discord: [discord.gg/jsVW4vJw27](https://discord.gg/jsVW4vJw27)
- Issues: [github.com/HybridAIOne/hybridclaw/issues](https://github.com/HybridAIOne/hybridclaw/issues)
- Discussions: [github.com/HybridAIOne/hybridclaw/discussions](https://github.com/HybridAIOne/hybridclaw/discussions)
