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

- The built-in `/chat` sidebar can search recent conversations by title and
  show contextual match snippets, so long-lived browser sessions are easier to
  reopen without scrolling through the default recent list.
- Browser chat and the console chat keep the composer focused after streamed
  replies finish, which makes keyboard-only follow-up turns faster.
- The bundled PDF creator wraps long lines, respects explicit `\n` line
  breaks, and adds pages automatically when content runs past the first page.
- Generated artifacts keep resolving correctly even when the sandbox exposes a
  custom workspace display root such as `/app`, so downloads and attachments
  stay stable in browser-driven workflows.

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
- Need to reach `/chat`, `/agents`, or `/admin` from another machine? Go to
  [Remote Access](./guides/remote-access.md).
- Need one markdown page that links the whole docs tree? Go to
  [For Agents](./agents.md).
