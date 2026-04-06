# HybridClaw

[![CI](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/HybridAIOne/hybridclaw/gh-pages/badge/coverage.json)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hybridaione/hybridclaw)](https://www.npmjs.com/package/@hybridaione/hybridclaw)
[![Node](https://img.shields.io/badge/node-22.x-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/en/download)
[![License](https://img.shields.io/github/license/HybridAIOne/hybridclaw)](https://github.com/HybridAIOne/hybridclaw/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-github%20pages-blue)](https://hybridaione.github.io/hybridclaw/)
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
operator and maintainer manual lives under
[docs/development/README.md](./docs/development/README.md).

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
| Self-hosted runtime | ✅ Gateway + sandboxed container runtime | ✅ Self-hosted runtime | ✅ Self-hosted runtime |
| Migration support | ✅ Import from OpenClaw and Hermes | ❌ | ❌ |
| Encrypted secrets | ✅ Encrypted store + SecretRefs | ⚠️ Partial | ⚠️ Partial |
| Approvals / governance | ✅ Approvals, audit trails, sandbox, config revision history | ⚠️ Limited | ⚠️ Limited |
| Shared enterprise knowledge | ✅ Shared memory + HybridAI knowledge/RAG path | ⚠️ Memory wiki + embeddings | ⚠️ Self-improving memory stack |
| Multi-agent observability | ✅ Built-in audit surfaces + HybridAI observability path | ❌ | ❌ |
| Local + cloud deployment model | ✅ Local-first runtime with HybridAI cloud path | ⚠️ Self-hosted focus | ⚠️ Self-hosted focus |
| Multiple UIs | ✅ TUI + Chat UI + Admin UI + Agents UI | ✅ TUI + WebChat + Control UI | ❌ TUI only |

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

- **Gateway service** (Node.js) — shared message/command handlers, SQLite persistence (KV + semantic + knowledge graph + canonical sessions + usage events), scheduler, heartbeat, web/API, and channel integrations for Discord, Microsoft Teams, iMessage, WhatsApp, and email
- **TUI client** — thin client over HTTP (`/api/chat`, `/api/command`) with
  a structured startup banner that surfaces model, sandbox, gateway, and
  chatbot context before the first prompt
- **Container** (Docker, ephemeral) — HybridAI API client, sandboxed tool executor, and preinstalled browser automation runtime with cursor-aware snapshots for JS-heavy custom UI
- Communication via file-based IPC (input.json / output.json)

## Documentation

Browse the full manual in
[docs/development/README.md](./docs/development/README.md).

- Getting started:
  [Installation](./docs/development/getting-started/installation.md),
  [Authentication](./docs/development/getting-started/authentication.md), and
  [Quick Start](./docs/development/getting-started/quickstart.md)
- Enterprise deployment:
  [Runtime Internals](./docs/development/internals/runtime.md) and
  [Architecture](./docs/development/internals/architecture.md)
- Security:
  [SECURITY.md](./SECURITY.md) and [TRUST_MODEL.md](./TRUST_MODEL.md)
- Migration:
  [Commands: Migration](./docs/development/reference/commands.md#migration) and
  [FAQ](./docs/development/reference/faq.md#can-i-migrate-an-existing-openclaw-or-hermes-agent-home)
- Channels:
  [Channel Setup](./docs/development/getting-started/channels.md),
  [iMessage](./docs/imessage.md), and [MS Teams](./docs/msteams.md)
- Skills and plugins:
  [Extensibility](./docs/development/extensibility/README.md),
  [Bundled Skills](./docs/development/guides/bundled-skills.md), and
  [Plugin System](./docs/development/extensibility/plugins.md)
- Configuration:
  [Configuration Reference](./docs/development/reference/configuration.md)
- CLI reference:
  [Commands](./docs/development/reference/commands.md),
  [Diagnostics](./docs/development/reference/diagnostics.md), and
  [FAQ](./docs/development/reference/faq.md)

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
