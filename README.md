# HybridClaw

[![CI](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/HybridAIOne/hybridclaw/gh-pages/badge/coverage.json)](https://github.com/HybridAIOne/hybridclaw/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hybridaione/hybridclaw)](https://www.npmjs.com/package/@hybridaione/hybridclaw)
[![Node](https://img.shields.io/badge/node-22.x-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/en/download)
[![License](https://img.shields.io/github/license/HybridAIOne/hybridclaw)](https://github.com/HybridAIOne/hybridclaw/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-github%20pages-blue)](https://hybridaione.github.io/hybridclaw/)
[![Powered by HybridAI](https://img.shields.io/badge/powered%20by-HybridAI-blueviolet)](https://hybridai.one)
[![Discord](https://img.shields.io/badge/Discord-join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/jsVW4vJw27)

<img width="540" height="511" alt="HybridClaw - The enterprise operating layer for open agents" src="docs/hero.png" />

**The enterprise operating layer for open agents.**
Self-hosted, controllable, and built for real business workflows.

Most open agent stacks are optimized for experimentation and breadth.

HybridClaw is optimized for enterprise deployment:
- controlled execution
- shared knowledge
- observability
- repeatable workflows
- local-first with a cloud path via HybridAI

> “Finally an assistant that actually follows you everywhere — without having to explain everything again every time.”

## 🚀 Quick Start (2 minutes)

```bash
# 1. Global installation
npm install -g @hybridaione/hybridclaw

# 2. Onboarding (sets up LLM, channels, secrets, everything)
hybridclaw onboarding

# 3. Start using it
hybridclaw gateway      # Start the backend
hybridclaw tui          # Terminal interface (optional)
```

After that open:

Web Chat: http://127.0.0.1:9090/chat
Admin Console: http://127.0.0.1:9090/admin
Agent Dashboard: http://127.0.0.1:9090/agents

Requirement: Node.js 22 (Docker recommended for sandbox)

Release notes live in [CHANGELOG.md](./CHANGELOG.md), and the browsable
operator and maintainer manual lives under
[docs/development/README.md](./docs/development/README.md).

## Coming from OpenClaw or Hermes?

```bash
# Migration in under 2 minutes — preview first
hybridclaw migrate openclaw --preview
hybridclaw migrate openclaw          # real migration
```

All skills, memory, config and secrets are transferred. Zero data loss.

## See it in Action

Once the gateway is running, open HybridClaw locally:

- Web Chat: `http://127.0.0.1:9090/chat`
- Admin Console: `http://127.0.0.1:9090/admin`
- Agent Dashboard: `http://127.0.0.1:9090/agents`

## Why HybridClaw instead of OpenClaw, Hermes Agent, LangChain, or n8n?

| Feature | HybridClaw | OpenClaw | Hermes Agent | LangChain | n8n |
| --- | --- | --- | --- | --- | --- |
| **One brain across channels** | ✅ Native (Discord, Teams, WhatsApp, iMessage, Email, Web, Terminal) | ✅ 20+ channels | ✅ 7 channels | ❌ Framework only | ⚠️ Via workflows (not native) |
| **Shared memory & context** | ✅ Persistent across all channels | ✅ Memory-wiki + embeddings | ✅ Self-improving + Honcho model | ✅ (you build it) | ✅ RAG / vector DBs |
| **Local LLM support** | ✅ Deep integration (Ollama, LM Studio, llama.cpp, vLLM) | ✅ Multiple providers | ✅ Ollama native | ✅ Excellent | ✅ Ollama + others |
| **Encrypted secrets + SecretRefs** | ✅ Full encrypted store + gateway injection | Partial | Partial | ❌ Manual | Partial |
| **GDPR / Enterprise-ready** | ✅ Audit trails, sandbox, approvals, config versioning | Limited | Limited | ❌ No | ✅ Strong (workflows) |
| **Portable `.claw` agent packages** | ✅ Snapshot + backup + install | ❌ | ❌ | ❌ | ❌ |
| **1-command migration** | ✅ From OpenClaw & Hermes | — | — | — | — |
| **Multiple UIs** | ✅ TUI + Web Chat + Admin Console + Agent Dashboard | ✅ TUI + WebChat + Control UI | ✅ Full TUI only | ❌ None | ✅ Visual workflow builder |
| **Self-improving / adaptive skills** | ✅ Adaptive skill loop + health | ✅ ClawHub skills | ✅ Strongest learning loop | ✅ (you code it) | ✅ Via AI nodes |
| **No-code workflow building** | ✅ CLI + skills + kanban | ⚠️ Skills + ClawHub | ⚠️ Skills Hub | ❌ Code-first | ✅ Best-in-class no-code |
| **Setup & onboarding** | ✅ `npm install -g` + `onboarding` (2 min) | ✅ Onboard CLI | ✅ One-line curl install | ❌ Requires coding | ✅ Visual + templates |

## HybridAI Advantage

- Security-focused foundation
- Enterprise-ready stack
- EU-stack compatibility
- GDPR-aligned posture
- RAG-powered retrieval
- Document-grounded responses

## Architecture

- **Gateway service** (Node.js) — shared message/command handlers, SQLite persistence (KV + semantic + knowledge graph + canonical sessions + usage events), scheduler, heartbeat, web/API, and channel integrations for Discord, Microsoft Teams, iMessage, WhatsApp, and email
- **TUI client** — thin client over HTTP (`/api/chat`, `/api/command`) with
  a structured startup banner that surfaces model, sandbox, gateway, and
  chatbot context before the first prompt
- **Container** (Docker, ephemeral) — HybridAI API client, sandboxed tool executor, and preinstalled browser automation runtime with cursor-aware snapshots for JS-heavy custom UI
- Communication via file-based IPC (input.json / output.json)

## Secrets And Authenticated API Calls

HybridClaw can keep API keys out of model-visible prompts and tool arguments.

```text
/secret set STAGING_HYBRIDAI_API_KEY demo_key_2024
/secret route add https://staging.hybridai.one/api/v1/ STAGING_HYBRIDAI_API_KEY X-API-Key none
```

After that, the model can just ask for the API call in natural language:

```text
POST to https://staging.hybridai.one/api/v1/virtual-bots/survey with JSON:
{
  "question": "Climate change is the biggest threat to humanity.",
  "sample_size": 10,
  "survey": "eurobarometer",
  "gender": "Man",
  "min_age": 25,
  "max_age": 65
}
```

Or you can use an explicit placeholder:

```text
POST to https://staging.hybridai.one/api/v1/virtual-bots/survey with header X-API-Key: <secret:STAGING_HYBRIDAI_API_KEY> and the same JSON body.
```

- The model only sees the secret name or placeholder, never the real token.
- The gateway injects the real header at request time via `http_request`.
- Tool-call audit records redact injected secret values before persistence.
- Selected config fields such as `ops.webApiToken`, `ops.gatewayApiToken`,
  `imessage.password`, and `local.backends.vllm.apiKey` can also use
  SecretRefs like `{ "source": "store", "id": "IMESSAGE_PASSWORD" }` or
  `${ENV_VAR}` instead of plaintext config values.

## Setting Up Channels

See [docs/development/getting-started/channels.md](./docs/development/getting-started/channels.md)
for the setup commands and step-by-step flows for:

- Discord
- Email
- WhatsApp
- iMessage
- Microsoft Teams

For transport-specific deep dives:

- [docs/imessage.md](./docs/imessage.md) covers local macOS and BlueBubbles
  remote setup in detail
- [docs/msteams.md](./docs/msteams.md) covers the Azure app, bot resource, and
  webhook registration flow

## Authenticated Browser Sessions

Use the browser profile commands when the agent needs to work inside a site
that requires a real login:

```bash
hybridclaw browser login --url https://accounts.google.com
hybridclaw browser status
hybridclaw browser reset
```

- `browser login` opens a headed Chromium profile stored under the HybridClaw
  runtime data directory and waits for you to close the browser when setup is
  finished.
- Browser sessions persist across turns and are made available to browser
  automation automatically, so follow-up browser tasks can reuse cookies and
  local storage without exposing credentials in chat.
- Treat the browser profile directory as sensitive operator data.

## Agent Packages

HybridClaw can package an agent into a portable `.claw` archive for backup,
distribution, or bootstrap flows:

```bash
hybridclaw agent list
hybridclaw agent export main -o /tmp/main.claw
hybridclaw agent inspect /tmp/main.claw
hybridclaw agent install /tmp/main.claw --id demo-agent --yes
hybridclaw agent install official:charly-neumann-executive-briefing-chief-of-staff --yes
hybridclaw agent activate demo-agent
```

- `agent export` exports the workspace plus optional bundled workspace skills
  and home plugins.
- `agent inspect` validates the manifest and prints archive metadata without
  extracting it.
- `agent install` restores the agent, fills missing bootstrap files, and
  re-registers bundled content with the runtime from a local `.claw` file, a
  direct `.claw` URL, or a packaged GitHub source such as `official:<agent-dir>`
  or `github:owner/repo[/<ref>]/<agent-dir>`.
- `agent install --skip-import-errors` continues when a manifest-declared skill
  import fails and prints retry commands for the skipped imports.
- `.claw` manifests can include agent presentation metadata such as a
  `displayName` and workspace-relative profile image asset for web chat.
- `agent activate <agent-id>` sets the default agent for new requests that do
  not specify one explicitly.
- Legacy aliases still work: `agent pack` maps to `export`, and `agent unpack`
  maps to `install`.
- See [docs/development/extensibility/agent-packages.md](./docs/development/extensibility/agent-packages.md)
  for the archive layout, manifest fields, and security rules.

## Migrating from OpenClaw / Hermes Agent

HybridClaw can import compatible state from an existing `~/.openclaw` or
`~/.hermes` home into a target HybridClaw agent workspace.

```bash
hybridclaw migrate openclaw --dry-run
hybridclaw migrate hermes --dry-run
```

Notes:

- Use `--agent <id>` to import into an agent other than `main`.
- Use `--overwrite` to replace existing HybridClaw files or config values when
  the preview shows conflicts.
- Use `--migrate-secrets` to import compatible secret material into the
  encrypted `~/.hybridclaw/credentials.json` store.
- Execute-mode runs write a report under `~/.hybridclaw/migration/openclaw/`
  or `~/.hybridclaw/migration/hermes/`.

## Local Provider Quickstart (LM Studio Example)

If LM Studio is running locally and serving `qwen/qwen3.5-9b` on
`http://127.0.0.1:1234`, use this setup:

1. Configure HybridClaw for LM Studio:

```bash
hybridclaw auth login local lmstudio qwen/qwen3.5-9b --base-url http://127.0.0.1:1234
```

This enables local providers, enables the LM Studio backend, normalizes the
URL to `http://127.0.0.1:1234/v1`, and sets the default model to
`lmstudio/qwen/qwen3.5-9b`.

2. Restart the gateway in host sandbox mode:

```bash
hybridclaw gateway restart --foreground --sandbox=host
```

If the gateway is not running yet, use:

```bash
hybridclaw gateway start --foreground --sandbox=host
```

3. Check that HybridClaw can see LM Studio:

```bash
hybridclaw gateway status
```

Look for `localBackends.lmstudio.reachable: true`.

You can also inspect the saved local backend config directly:

```bash
hybridclaw auth status local
```

4. Start the TUI:

```bash
hybridclaw tui
```

In the TUI, run:

```text
/model list
/model list openrouter
/model set lmstudio/qwen/qwen3.5-9b
/model clear
/model info
```

Then send a normal prompt.

If you want to configure the backend without changing your global default model,
use:

```bash
hybridclaw auth login local lmstudio qwen/qwen3.5-9b --base-url http://127.0.0.1:1234 --no-default
```

Other backends use the same flow:

```bash
hybridclaw auth login local ollama llama3.2
hybridclaw auth login local llamacpp --base-url http://127.0.0.1:8081
hybridclaw auth login local llamacpp Meta-Llama-3-8B-Instruct --base-url http://127.0.0.1:8081
hybridclaw auth login local vllm mistralai/Mistral-7B-Instruct-v0.3 --base-url http://127.0.0.1:8000 --api-key secret
```

Restart the gateway in `--sandbox=host`, then confirm reachability with
`hybridclaw gateway status`.

Notes:

- LM Studio often shows its server as `http://127.0.0.1:1234`, but HybridClaw
  should be configured with `http://127.0.0.1:1234/v1`.
- Qwen models on LM Studio use the OpenAI-compatible `/v1` API with Qwen tool
  and thinking compatibility enabled automatically.
- For agent mode, load at least `16k` context in LM Studio. `32k` is the safer
  default for longer sessions and tool use.
- The TUI `/model` picker and Discord `/model` slash command choices are built
  from the live gateway model list, so restart the gateway after enabling a new
  local backend or loading a different local model.

## Bundled Skills

HybridClaw currently ships with 30 bundled skills. Notable workflow and app
integrations include:

- `pdf` is bundled and supports text extraction, page rendering, fillable form inspection/filling, and non-fillable overlay workflows.
- `xlsx` is bundled for spreadsheet creation, formula-safe editing, CSV/TSV cleanup, and LibreOffice-backed recalculation.
- `docx` is bundled for Word document creation plus OOXML unpack/edit/pack workflows, comments, and tracked-change cleanup.
- `pptx` is bundled for presentation creation with `pptxgenjs`, template-preserving OOXML edits, and thumbnail-based visual QA.
- `office-workflows` is bundled for cross-format tasks such as CSV to XLSX cleanup and XLSX to PPTX or DOCX deliverables coordinated with delegation.
- `notion` is bundled for Notion workspace pages, block content, and data-source workflows over the Notion API.
- `trello` is bundled for board, list, and card management in lightweight Kanban workflows.
- `project-manager` is bundled for sprint plans, milestone breakdowns, risk registers, and stakeholder updates.
- `feature-planning` is bundled for repo-aware implementation plans, task sequencing, acceptance criteria, and validation strategy before coding.
- `code-review` is bundled for local diff reviews, PR reviews, risk-focused findings, and test-gap analysis.
- `code-simplification` is bundled for behavior-preserving refactors that reduce nesting, duplication, and unnecessary abstraction.
- `github-pr-workflow` is bundled for branch creation, commits, PR authoring, CI follow-up, and merge-readiness workflows with GitHub.
- `write-blog-post` is bundled for audience-aware blog post outlines and drafts built from briefs, notes, transcripts, or source material.
- `discord` is bundled for Discord channel operations through the `message` tool, including reads, sends, reactions, pins, and threads.
- `google-workspace` is bundled for Gmail, Calendar, Drive, Docs, and Sheets setup guidance plus browser/API workflow coordination.
- `1password` is bundled for secure `op`-based secret lookup and command injection workflows.
- `stripe` is bundled for Stripe API, CLI, Dashboard, checkout, billing, and webhook-debugging workflows with a test-mode-first default.
- `sokosumi` is bundled for API-key-authenticated Sokosumi agent hires, coworker tasks, job monitoring, and result retrieval without relying on the Ink TUI.
- `wordpress` is bundled for WP-CLI, wp-admin, and draft-first content publishing workflows on WordPress sites.
- `apple-calendar` is bundled for Apple Calendar or iCal workflows, especially `.ics` drafting/import and macOS calendar coordination.
- `apple-passwords` is bundled for Passwords.app and Keychain-backed credential lookup on macOS.
- `apple-music` is bundled for macOS Music app playback control, now-playing checks, and Apple Music URL workflows.
- Use `hybridclaw skill list` to inspect available installers and `hybridclaw skill install pdf [install-id]` when a bundled skill advertises optional setup helpers.
- Use `hybridclaw skill import official/himalaya` to install the packaged Himalaya community skill into `~/.hybridclaw/skills` for host-side IMAP/SMTP email workflows.
- Use `hybridclaw skill import <source>` to install community skills into `~/.hybridclaw/skills` from `skills-sh/anthropics/skills/brand-guidelines`, `clawhub/brand-voice`, `lobehub/github-issue-helper`, `claude-marketplace/brand-guidelines@anthropic-agent-skills`, `well-known:https://mintlify.com/docs`, or explicit GitHub repo/path refs such as `anthropics/skills/skills/brand-guidelines`.
- Use `hybridclaw skill import --force <source>` to override a `caution` scanner verdict for a reviewed community skill. `dangerous` verdicts stay blocked.

Skills can be disabled globally or per channel kind (`discord`, `msteams`,
`whatsapp`, `email`) with `hybridclaw skill enable|disable <name> [--channel <kind>]`
or via the TUI `/skill config` screen. For observation-driven health and
amendment workflows, use `hybridclaw skill inspect|runs|learn|history` or the
admin `Skills` page.

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
