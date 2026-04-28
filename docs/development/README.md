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

- Signal joins the channel catalog with a `signal-cli` daemon setup flow,
  private-by-default DM policy, group controls, and admin QR linking.
- `.confidential.yml` rules can redact NDA-class business data before model
  calls, while `hybridclaw audit scan-leaks` scans historical audit logs for
  possible leaks.
- Web chat shows live context-window usage, supports `/context`, searches
  recent sessions, and can switch the active agent from the composer.
- The admin console includes statistics and agent-scoreboard pages for
  sessions, messages, tokens, cost trends, skill scores, reliability, timing,
  and CV links.
- Packaged business skills can declare manifests, capabilities, required
  credentials, supported channels, lifecycle snapshots, and rollback history.
- Deployment config can describe cloud/local mode and tunnel provider intent;
  the built-in ngrok provider reads `NGROK_AUTHTOKEN` from encrypted secrets.
- Model info, usage summaries, and the admin Models page surface discovered
  context windows, output limits, capabilities, pricing, and monthly spend
  where providers expose the metadata.

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
