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

- HybridClaw now supports `Mistral` as a first-class provider, including
  `hybridclaw auth login|status|logout mistral`, `mistral/...` model
  selection, and discovered catalog metadata in selectors and status output.
- `export trace [sessionId|all]` now emits `ATIF`-compatible trace JSONL with
  tool-call, token-usage, and git-context metadata for offline debugging and
  analysis.
- The browsable docs shell moved to `/docs`, raw-markdown docs now have a
  dedicated [For Agents](./agents.md), and HybridClaw product questions
  route through a bundled `hybridclaw-help` skill plus public docs retrieval.
- Built-in web chat streaming is smoother under live output thanks to batched
  rendering, decoder-tail handling, NDJSON fallback support, and preserved
  scroll position during stream updates.
- The bundled `obsidian` skill adds first-party vault workflows for searching,
  creating, and organizing notes while preserving existing wikilink patterns.

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
