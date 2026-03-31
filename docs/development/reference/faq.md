---
title: FAQ
description: Common setup, security, runtime, and channel-operation questions.
sidebar_position: 6
---

# FAQ

## How do I diagnose setup problems quickly?

Run `hybridclaw doctor`. It checks runtime, gateway, config, credentials,
database, providers, Docker, channels, skills, security, and disk state in
parallel. Use `--fix` for safe remediations and `--json` for CI-friendly
output.

## Why does onboarding ask me to accept `TRUST_MODEL.md`?

HybridClaw requires explicit trust-model acceptance before runtime starts.
Acceptance is recorded in `config.json` with policy version and timestamp.

## Do I still configure everything through `.env`?

No. Runtime behavior lives in typed `config.json` and runtime secrets live in
`~/.hybridclaw/credentials.json`. A local `.env` is only used for one-time
compatibility import of supported secrets.

## Is it safe to let the agent run shell commands?

By default, tools run inside ephemeral Docker containers with read-only
filesystems, memory caps, dropped capabilities, `no-new-privileges`, and other
guardrails. Host sandbox mode trades container isolation for workspace fencing
and command guardrails.

## Can browser tools test real login flows?

Yes, when explicitly requested for the intended site. Sensitive credential
values are still redacted from structured audit logs.

## Can I attach files or paste screenshots in the web chat or TUI?

Yes. The built-in web chat accepts uploads and pasted clipboard files or
images before send. TUI can queue a copied local file or clipboard image with
`/paste` or `Ctrl-V`.

## Can I point a prompt at files, diffs, or URLs without pasting them?

Yes. Use inline references such as `@file:path[:start-end]`, `@folder:path`,
`@diff`, `@staged`, `@git:<count>`, and `@url:https://...`. When a reference
cannot be attached safely or would exceed prompt budget, HybridClaw leaves the
prompt text intact and adds a warning instead of silently broadening access.

## Can I use HybridClaw without Discord?

Yes. You can run `hybridclaw tui`, use the built-in web chat, or connect
Microsoft Teams, iMessage, WhatsApp, and email.

## What AI models does it support?

HybridClaw supports HybridAI models, OpenAI Codex models, OpenRouter models,
Hugging Face router models, and local backends including Ollama, LM Studio,
and vLLM.

## Does the agent remember things between conversations?

Yes. The active agent writes daily memory files and curates longer-term notes
into `MEMORY.md`. Session continuity defaults to channel-and-peer isolation,
with linked-identity routing available when operators want shared continuity.

## Is there a web-based admin interface?

Yes. The gateway serves `/admin` for the operator console, `/chat` for the web
chat UI, `/agents` for the agent/session dashboard, and `/admin/terminal` for
a browser-based PTY session. The admin console includes Dashboard, Terminal,
Gateway, Sessions, Jobs, Bindings, Models, Scheduler, MCP, Audit, Skills,
Plugins, Tools, and Config pages.

## Can I extend HybridClaw with plugins?

Yes. HybridClaw supports local plugins with typed manifests, plugin tools,
memory layers, prompt hooks, and lifecycle hooks. Start with
[Extensibility](../extensibility/README.md).
