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

- Runtime secrets now live in an encrypted `~/.hybridclaw/credentials.json`
  store with separate master-key sourcing, named `/secret` entries, and
  SecretRef-backed config fields for supported runtime settings.
- The gateway can inject stored credentials into outbound `http_request` calls
  by URL rule or `<secret:NAME>` placeholder, keeping plaintext API keys out of
  model-visible prompts and persisted tool-call payloads.
- `hybridclaw migrate openclaw` and `hybridclaw migrate hermes` can preview or
  import compatible workspace files, config, model settings, and optional
  secrets into a target HybridClaw agent.
- Local-provider setup now includes first-class `llama.cpp` support, optional
  model ids for `auth login local`, and onboarding paths that let local-only
  operators skip remote-provider auth entirely.

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
