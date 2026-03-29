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

## Latest Highlights

- HybridClaw now supports `iMessage` with either a local macOS `imsg` +
  `chat.db` backend or a remote BlueBubbles relay, plus a dedicated setup
  guide and `hybridclaw channels imessage setup`.
- The embedded admin console now includes a live `Terminal` page at
  `/admin/terminal` so operators can open a browser-based PTY session without
  leaving the admin shell.
- `hybridclaw config`, `config check`, `config reload`, and
  `config set <key> <value>` now cover the local runtime config lifecycle,
  with matching `/config` slash commands in TUI and web sessions.
- HybridAI observability export, clearer browser-tool doctor suggestions, and
  tighter plugin/browser recovery flows all landed for day-to-day operator
  work.

## Browse By Section

- [Getting Started](./getting-started/README.md) for installation,
  onboarding, provider authentication, and first-run setup
- [Guides](./guides/README.md) for local providers, MCP, bundled skills,
  voice/TTS, and optional office tooling
- [Reference](./reference/README.md) for model selection, configuration,
  diagnostics, commands, and FAQ
- [Extensibility](./extensibility/README.md) for tools, skills, plugins,
  agent packages, and extension-specific operator workflows
- [Internals](./internals/README.md) for architecture, runtime behavior,
  session routing, testing, and release mechanics

## Fast Paths

- Need to install HybridClaw quickly? Go to
  [Installation](./getting-started/installation.md).
- Need the shortest path to a running gateway and chat UI? Go to
  [Quick Start](./getting-started/quickstart.md).
- Need command lookup or troubleshooting help? Go to
  [Commands](./reference/commands.md) and
  [Diagnostics](./reference/diagnostics.md).
- Need setup answers before deploying? Go to [FAQ](./reference/faq.md).
