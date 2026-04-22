---
title: HybridClaw Docs
description: User, operator, and developer documentation for HybridClaw installation, channels, workflows, extensibility, and runtime internals.
sidebar_position: 1
---

# HybridClaw Docs

Welcome to the HybridClaw handbook — the operator, contributor, and
advanced-user manual for running, extending, and understanding HybridClaw. The
chapters are organized around what you are trying to do rather than how the
repository is laid out. **Getting Started** walks through installation,
onboarding, and your first run. **Channels** is the transport reference across
Discord, Slack, Telegram, email, WhatsApp, iMessage, and Microsoft Teams.
**Guides** collects task-focused walkthroughs for everyday operational work,
**Tutorials** provides practical owner, GTM, marketing, sales, and community
workflows, **Extensibility** covers tools, skills, plugins, and the extension
architecture, and the **Developer Guide** goes deeper into architecture and
maintainer-facing internals. When you just need a fact — a command, a config
key, a diagnostic — **Reference** is the place to land.

Every page in the browser docs shell keeps its raw `.md` source one click
away: open it directly from the header, or copy the full page markdown for
sharing and quoting. If you prefer a single markdown index that links every
doc at once, start from [For Agents](./agents.md).

## Latest Highlights

- `/btw <question>` is available across local and Discord slash-command
  surfaces for ephemeral side questions that use recent conversation context
  without persisting the side exchange to session history.
- The built-in browser chat accepts `/btw` while a primary run is active and
  renders those replies in a dedicated side-thread style.
- Bash tool calls preserve shell state (`cd`, exported env vars, aliases)
  across calls for the active runtime session by default, with
  `container.persistBashState` and a matching admin toggle to switch back to
  stateless behavior.
- Discord, Email, and WhatsApp classify expected transient transport outages
  locally and rate-limit repetitive outage warnings, which reduces noise during
  reconnect storms.
- Artifact remapping preserves host-resolved workspace paths even when display
  and runtime workspace roots differ, keeping generated files downloadable in
  cloud-backed sessions.

## Browse By Section

- [Getting Started](./getting-started/README.md) for installation,
  onboarding, provider authentication, and connecting the first transport
- [Channels](./channels/README.md) for the full supported channel catalog and
  transport-specific setup details
- [Guides](./guides/README.md) for local providers, MCP, bundled skills,
  remote access, voice/TTS, and optional office tooling
- [Tutorials](./tutorials/README.md) for practical owner, GTM, marketing,
  sales, and community workflows
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
