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

- Concierge routing can ask users about urgency before long-running requests,
  then route execution through configurable `asap`, `balanced`, or
  `no_hurry` model profiles from gateway, TUI, or slash-command surfaces.
- `hybridclaw config revisions [list|rollback|delete|clear]` now tracks
  auditable runtime config snapshots in
  `~/.hybridclaw/data/config-revisions.db` so local config changes can be
  reviewed and restored.
- Agent installs now support direct `.claw` URLs, session-side `/agent install`
  flows, and `--skip-import-errors` for partial imported-skill failures while
  keeping the rest of the archive install moving.
- Plugins can expose inbound webhook endpoints and dispatch normalized inbound
  messages through the same assistant turn pipeline used by built-in channels.
- The bundled `sokosumi` skill adds API-key-authenticated workflows for agent
  hires, coworker task creation, job monitoring, and result retrieval.

## Browse By Section

- [Getting Started](./getting-started/README.md) for installation,
  onboarding, provider authentication, and first-run setup
- [Guides](./guides/README.md) for local providers, MCP, bundled skills,
  voice/TTS, and optional office tooling
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
- Need one markdown page that links the whole docs tree? Go to
  [For Agents](./agents.md).
