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

## Coming Up Highlights

- Hugging Face router support has landed with provider auth commands, doctor
  probing, model discovery, and `huggingface/...` model selection support.
- The embedded admin console has a dedicated `Jobs` board for proactive work,
  alongside scheduler/job follow-ups that recover more reliably after failed
  runs or delayed delivery.
- `hybridclaw tool list|enable|disable` gives operators a direct way to trim
  unused built-in prompt surfaces when doctor recommends it.
- Container bootstrap behavior is clearer: installed packages prefer published
  images, source checkouts build locally, and the publish workflow verifies
  pushed GHCR tags before completion.
- Skill install/sync path handling, malformed `requires` warnings, and
  OpenClaw-compatible metadata parsing all received cleanup and stability work.

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
