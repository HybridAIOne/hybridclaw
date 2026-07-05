---
title: Quick Start
description: Go from nothing to a working system — a running gateway and your first answered message — in a few minutes.
sidebar_position: 3
---

# Quick Start

The goal of this page is a **working system**: a running gateway and your first
answered message. There are two paths.

- **HybridAI Cloud** — fastest; you are already running. See
  [Fastest Path: HybridAI Cloud](#fastest-path-hybridai-cloud).
- **Local / self-hosted** — a few numbered steps. See
  [Local / Self-Hosted: Zero To Working](#local--self-hosted-zero-to-working).

Both paths meet at [Send Your First Message](#send-your-first-message).

## Fastest Path: HybridAI Cloud

If you started from [HybridAI Cloud](https://hybridclaw.io) (see
[Installation](./installation.md#launch-on-hybridai-cloud)), there is nothing to
install or configure:

- a default model is already selected
- the gateway is already running
- you land directly in web chat at `/chat`

You already have a working system. Skip ahead to
[Send Your First Message](#send-your-first-message), then
[Where To Go Next](#where-to-go-next).

## Local / Self-Hosted: Zero To Working

The path is: **onboard → start the gateway → confirm it is healthy → open
chat**. Get one clean conversation working first; add channels, sandboxes, and
remote access afterward.

First install the CLI — see [Installation](./installation.md). You need Node.js
22 and npm, plus Docker if you want the default container sandbox.

### 1. Onboard

```bash
hybridclaw onboarding
```

Follow the prompts: accept `TRUST_MODEL.md`, choose HybridAI auth or a
local-only setup, and save a default model. On first run a fresh agent also
introduces itself, keeps your setup links in chat, and suggests first jobs (see
[Agents](../agents.md)).

- **Cloud / managed providers:** sign in to HybridAI or pick another provider.
  You can add more providers anytime — see [Authentication](./authentication.md).
- **Local-only (Ollama, LM Studio, llama.cpp, vLLM):** you can skip the
  remote-provider steps and configure a backend later with
  `hybridclaw auth login local <backend> [model-id]`.

If onboarding finds invalid JSON in `~/.hybridclaw/config.json`, it can restore
the last known-good snapshot or roll back to a tracked revision before
continuing.

### 2. Start the gateway

```bash
hybridclaw gateway
```

The gateway is the backbone — the chat UI, agents, and channels all run on it.

Variants you may need later: `hybridclaw gateway start --foreground` to watch
logs, and `--sandbox=host` for stdio MCP servers that depend on host binaries
such as `docker`, `node`, or `npx`.

### 3. Confirm it is healthy

```bash
hybridclaw gateway status
hybridclaw doctor
```

`gateway status` reports the running gateway with its active sandbox and runtime
metadata (in container mode it also shows the image name, version, and short
id). `doctor` flags common config and credential problems. Both clean → you are
ready.

### 4. Open chat

With the gateway running locally, open either surface:

- **Web chat:** `http://127.0.0.1:9090/chat`
- **Terminal UI:** `hybridclaw tui`

If `WEB_API_TOKEN` is unset, localhost access opens without a login prompt; if
it is set, `/chat`, `/apps`, `/agents`, and `/admin` reuse the same token. The
[desktop app](./installation.md#install-the-apple-desktop-app) opens this chat
surface automatically.

## Send Your First Message

Try a prompt that exercises the model and file grounding:

```text
Summarize @file:README.md in 5 bullets.
```

You have a working system when:

- the bot/model name shows in the chat header (or the TUI banner)
- the reply streams back with no auth or model error
- if a tool needs approval, the approval picker appears

Grounding references work in any prompt: `@file:path[:start-end]`,
`@folder:path`, `@diff`, `@staged`, `@git:<count>`, and `@url:https://...`. Web
chat also accepts uploads and pasted images; the TUI queues a copied file or
clipboard image with `/paste` or `Ctrl-V`. For example:

```text
Explain this change using @diff and @file:src/gateway/gateway-service.ts:900-1040
```

The chat header shows a live context-usage ring. Use `/context` for the full
snapshot, `/compact` when a long session nears the model window, and `/model` to
switch models.

## If Something's Wrong

Start with diagnostics:

```bash
hybridclaw doctor
```

Common cases:

- **Empty reply or model error** → check provider auth with
  `hybridclaw auth status <provider>` (see [Authentication](./authentication.md)).
- **Chat will not load / cannot reach the gateway** → `hybridclaw gateway status`,
  then `hybridclaw gateway restart --foreground`.
- **Config broke after a manual edit** → re-run `hybridclaw onboarding` and let
  it restore the last known-good snapshot.
- **Cannot resume a session** → `hybridclaw tui --resume <sessionId>` (the TUI
  prints the id in its exit summary).

Full reference: [Diagnostics](../reference/diagnostics.md).

## Where To Go Next

With one conversation working, expand the system:

- [Connect Your First Channel](./first-channel.md) — Slack, Discord, Telegram,
  Signal, WhatsApp, email, and more, with a private first-rollout checklist.
- [Local vs Cloud Setup](./local-vs-cloud.md) — when you need a public URL,
  tunneling, or a cloud deployment, and how to switch between modes.
- [Remote Access](../guides/remote-access.md) — reach the gateway from your
  other devices over SSH or Tailscale without exposing it publicly.

Other built-in surfaces on the running gateway (`http://127.0.0.1:9090`):

- `/agents` — agent and session dashboard; the `/chat` sidebar also searches
  past sessions by title
- `/apps` — generated app gallery for self-contained HTML apps, documents,
  games, tools, and live connector-backed views
- `/admin` — channels, agents, and skills, plus saved-revision editing
- `/admin/statistics` and `/admin/agent-scoreboard` — activity, cost, and skill
  scores
- `/docs` — these docs, served locally

## Command Cheat Sheet

| Command | Purpose |
| --- | --- |
| `hybridclaw onboarding` | First-run setup: trust model, auth, default model |
| `hybridclaw gateway` | Start the gateway (the backbone) |
| `hybridclaw gateway status` | Confirm it is running; show sandbox and runtime |
| `hybridclaw gateway restart --foreground` | Restart and watch logs |
| `hybridclaw tui` | Open the terminal chat UI |
| `hybridclaw tui --resume <sessionId>` | Resume a previous TUI session |
| `hybridclaw doctor` | Diagnose config and credential problems |
| `hybridclaw auth login` / `auth status` | Add a provider / check provider auth |
