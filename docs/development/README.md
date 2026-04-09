---
title: HybridClaw Docs
description: User-facing HybridClaw documentation for installation, setup, operations, extensibility, and runtime internals.
sidebar_position: 1
---

# HybridClaw Docs

This section turns the repo-shipped markdown docs into a browsable manual for
operators, contributors, and advanced users. Start with the section that best
matches what you need right now. In the browser docs shell, each page can open
its raw `.md` source directly or copy the full page markdown from the document
header.

If you want a raw-markdown entrypoint that links every docs page directly, use
[For Agents](./agents.md).

## Latest Highlights

- The admin console's Channels page centralizes transport status and
  browser-based setup across Discord, WhatsApp, email, Microsoft Teams, and
  iMessage, including managed secrets and live WhatsApp pairing QR display.
- The gateway exposes a loopback OpenAI-compatible API at `/v1/models` and
  `/v1/chat/completions` for local eval harnesses and OpenAI-compatible tools.
- Built-in email delivery and the repo-shipped `brevo-email` plugin can
  continue existing mail threads by forwarding explicit `inReplyTo` and
  `references` Message-ID headers on outbound replies.
- Provider and channel setup flows keep secrets hidden during interactive
  prompts, and local `auth status` commands report sensitive credentials as
  `configured` instead of echoing partial values.
- `hybridclaw tui` follows the active sandbox mode from a reachable gateway
  during preflight, which keeps host-mode MCP and containerized deployments
  aligned.

## Browse By Section

- [Getting Started](./getting-started/README.md) for installation,
  onboarding, provider authentication, and first-run setup
- [Guides](./guides/README.md) for local providers, MCP, bundled skills,
  remote access, voice/TTS, and optional office tooling
- [Extensibility](./extensibility/README.md) for tools, skills, plugins,
  agent packages, and extension-specific operator workflows
- [Internals](./internals/README.md) for architecture, runtime behavior,
  session routing, testing, and release mechanics
- [Reference](./reference/README.md) for model selection, configuration,
  diagnostics, commands, and FAQ

## Fast Paths

- Need to install HybridClaw quickly? Go to
  [Installation](./getting-started/installation.md).
- Need the shortest path to a running gateway and chat UI? Go to
  [Quick Start](./getting-started/quickstart.md).
- Need command lookup or troubleshooting help? Go to
  [Commands](./reference/commands.md) and
  [Diagnostics](./reference/diagnostics.md).
- Need setup answers before deploying? Go to [FAQ](./reference/faq.md).
- Need to reach `/chat`, `/agents`, or `/admin` from another machine? Go to
  [Remote Access](./guides/remote-access.md).
- Need one markdown page that links the whole docs tree? Go to
  [For Agents](./agents.md).
