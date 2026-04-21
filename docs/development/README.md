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

- The built-in `/chat` sidebar can search recent conversations by title and
  show contextual match snippets, which makes browser-session recovery faster
  during day-to-day operator work.
- Browser chat and the console chat now restore focus to the composer after
  streamed replies finish, improving keyboard-only follow-up flows.
- The bundled PDF creator wraps long lines, respects explicit `\n` line
  breaks, and adds pages automatically when content overflows the first page.
- Generated artifacts now keep resolving correctly even when the sandbox maps a
  custom workspace display root such as `/app`, keeping browser downloads and
  attachments stable under alternate runtime layouts.

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
