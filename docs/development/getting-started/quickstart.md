---
title: Quick Start
description: Launch the gateway, TUI, and built-in web surfaces after onboarding.
sidebar_position: 3
---

# Quick Start

## Onboarding

HybridClaw onboarding walks through:

1. accepting `TRUST_MODEL.md`
2. choosing HybridAI auth or a local-only setup
3. opening HybridAI registration/login in the browser when needed
4. pasting the API key back into the CLI or skipping remote auth for a local backend
5. saving the default bot/model plus encrypted runtime secrets

Run it explicitly with:

```bash
hybridclaw onboarding
```

If you plan to run only on Ollama, LM Studio, llama.cpp, or vLLM, onboarding
can skip the remote-provider steps and you can configure the backend later with
`hybridclaw auth login local <backend> [model-id] ...`.

## Start The Gateway

```bash
hybridclaw gateway
```

Common variants:

```bash
hybridclaw gateway start --foreground
hybridclaw gateway start --foreground --sandbox=host
```

Use `--sandbox=host` for stdio MCP servers that depend on host binaries such
as `docker`, `node`, or `npx`.

## Start The TUI

In a second terminal:

```bash
hybridclaw tui
```

## Open The Built-In Web Surfaces

With the gateway running locally:

- chat UI: `http://127.0.0.1:9090/chat`
- agent/session dashboard: `http://127.0.0.1:9090/agents`
- admin console: `http://127.0.0.1:9090/admin`
- docs: `http://127.0.0.1:9090/docs`

If `WEB_API_TOKEN` is unset, localhost access opens without a login prompt. If
it is set, `/chat`, `/agents`, and `/admin` all reuse the same token gate.
For access from another machine, keep the gateway on loopback and follow
[Remote Access](../guides/remote-access.md).

## Ground A Prompt With Files Or Repo Context

- Web chat accepts uploads and pasted clipboard files or images before send.
- TUI queues a copied local file or clipboard image with `/paste` or `Ctrl-V`.
- Inline prompt references supported in chat are `@file:path[:start-end]`,
  `@folder:path`, `@diff`, `@staged`, `@git:<count>`, and
  `@url:https://...`.

Examples:

```text
Summarize @file:README.md and compare it with @url:https://example.com/spec
Explain this change using @diff and @file:src/gateway/gateway-service.ts:900-1040
```

## Channel Integrations

The gateway auto-connects configured channels:

- Microsoft Teams when `msteams.enabled` is true and
  `MSTEAMS_APP_PASSWORD` is saved
- Discord when `DISCORD_TOKEN` is set
- Email when `email.enabled` is true and an email password is configured,
  typically through the stored `EMAIL_PASSWORD` secret
- WhatsApp when linked auth exists under `~/.hybridclaw/credentials/whatsapp`

For the setup commands and step-by-step flows, see
[Channel Setup](./channels.md).
