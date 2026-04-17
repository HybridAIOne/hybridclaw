---
title: HybridClaw Docs
description: User, operator, and developer documentation for HybridClaw installation, channels, workflows, extensibility, and runtime internals.
sidebar_position: 1
---

# HybridClaw Docs

This section turns the repo-shipped markdown docs into a browsable manual for
operators, contributors, and advanced users. The structure follows audience and
job-to-be-done, not repository internals:

- `Getting Started` for first install, onboarding, and first run
- `Channels` for the canonical transport manual across Discord, Slack,
  Telegram, email, WhatsApp, iMessage, and Microsoft Teams
- `Guides` for operational and task-focused walkthroughs
- `Extensibility` for tools, skills, plugins, and extension architecture
- `Developer Guide` for architecture and maintainer-facing internals
- `Reference` for commands, configuration, diagnostics, and tool reference

In the browser docs shell, each page can open its raw `.md` source directly or
copy the full page markdown from the document header.

If you want a raw-markdown entrypoint that links every docs page directly, use
[For Agents](./agents.md).

## Latest Highlights

- `/admin/agents` lets operators edit allowlisted bootstrap markdown files for
  each registered agent, inspect saved revisions, and restore an earlier
  version from the browser.
- `hybridclaw tui` combines the startup banner, keyboard-driven approval
  picker, and resumable exit summary into one local operator workflow.
- If `~/.hybridclaw/config.json` becomes invalid JSON, interactive onboarding
  can restore the last known-good saved snapshot or roll back to a tracked
  config revision before setup continues.
- Built-in transport behavior is more predictable: email seeds its first
  mailbox cursor from the current head instead of replaying old inbox mail,
  retry-aware transports honor `Retry-After`, and WhatsApp startup avoids
  intermittent init-query bad-request failures.

## Browse By Section

- [Getting Started](./getting-started/README.md) for installation,
  onboarding, provider authentication, and connecting the first transport
- [Channels](./channels/README.md) for the full supported channel catalog and
  transport-specific setup details
- [Guides](./guides/README.md) for local providers, MCP, bundled skills,
  remote access, voice/TTS, and optional office tooling
- [Extensibility](./extensibility/README.md) for tools, skills, plugins,
  agent packages, and extension-specific operator workflows
- [Developer Guide](./developer-guide/README.md) for architecture, runtime
  behavior, session routing, testing, and release mechanics
- [Reference](./reference/README.md) for model selection, configuration,
  diagnostics, commands, and FAQ

## Fast Paths

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
- Need to reach `/admin/chat`, `/agents`, or `/admin` from another machine? Go to
  [Remote Access](./guides/remote-access.md).
- Need one markdown page that links the whole docs tree? Go to
  [For Agents](./agents.md).
