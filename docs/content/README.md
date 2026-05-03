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
Discord, Slack, Telegram, Signal, email, WhatsApp, iMessage, and Microsoft Teams.
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

- Signal joins the channel catalog with a full `signal-cli` daemon setup guide,
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
  the built-in ngrok, Tailscale, and Cloudflare providers read runtime auth
  secrets from encrypted storage.
- Model info, usage summaries, and the admin Models page surface discovered
  context windows, output limits, capabilities, pricing, and monthly spend
  where providers expose the metadata.
- Installation options include npm, source checkout, a multi-arch Nix flake,
  a NixOS module, and a preview Homebrew formula for `--HEAD` builds.

## Browse By Section

- [HybridClaw: The AI Coworker Who's Already On It](./manifesto.md) — the product principles HybridClaw is built around: what we will and will not ship
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
