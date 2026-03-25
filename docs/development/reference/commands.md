---
title: Commands
description: High-value CLI, gateway, agent, skill, plugin, and audit commands.
sidebar_position: 5
---

# Commands

## Core Runtime

```bash
hybridclaw --version
hybridclaw gateway start [--foreground] [--debug] [--log-requests] [--sandbox=container|host]
hybridclaw gateway restart [--foreground] [--debug] [--log-requests] [--sandbox=container|host]
hybridclaw gateway stop
hybridclaw gateway status
hybridclaw tui
hybridclaw onboarding
hybridclaw doctor [--fix|--json|<component>]
hybridclaw browser login [--url <url>]
hybridclaw browser status
hybridclaw browser reset
```

## Auth And Providers

```bash
hybridclaw auth login [provider] ...
hybridclaw auth status <provider>
hybridclaw auth logout <provider>
hybridclaw auth whatsapp reset
hybridclaw local configure <backend> <model-id> [--base-url <url>] [--api-key <key>] [--no-default]
```

## Agents And Packages

```bash
hybridclaw agent list
hybridclaw agent export [agent-id] [-o <path>]
hybridclaw agent inspect <file.claw>
hybridclaw agent install <file.claw> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--yes]
hybridclaw agent uninstall <agent-id> [--yes]
hybridclaw gateway agent [list|switch <id>|create <id>|model [name]]
```

`agent export` and `agent install` are the primary archive verbs. Legacy
aliases remain accepted: `agent pack` maps to `export`, and `agent unpack`
maps to `install`.

## Skills, Plugins, Audit

```bash
hybridclaw skill list
hybridclaw skill enable <skill-name> [--channel <kind>]
hybridclaw skill disable <skill-name> [--channel <kind>]
hybridclaw skill toggle [--channel <kind>]
hybridclaw skill inspect <skill-name>
hybridclaw skill inspect --all
hybridclaw skill runs <skill-name>
hybridclaw skill learn <skill-name> [--apply|--reject|--rollback]
hybridclaw skill history <skill-name>
hybridclaw skill import [--force] [--skip-skill-scan] <source>
hybridclaw skill install <skill-name> [install-id]
hybridclaw plugin list
hybridclaw plugin config <plugin-id> [key] [value|--unset]
hybridclaw plugin install <path|npm-spec>
hybridclaw plugin reinstall <path|npm-spec>
hybridclaw plugin uninstall <plugin-id>
hybridclaw audit recent
hybridclaw audit approvals [n] [--denied]
hybridclaw audit search <query>
hybridclaw audit verify [sessionId]
hybridclaw audit instructions [--sync]
```

`skill import [--force] [--skip-skill-scan]` supports packaged `official/<skill-name>` sources plus
community imports from `skills-sh`, `clawhub`, `lobehub`,
`claude-marketplace`, `well-known`, and explicit GitHub repo/path refs.

## In Session

- TUI and chat surfaces use `/agent`, `/model`, `/mcp`, `/plugin`, `/skill`,
  `/compact`, `/reset`, `/skill import`, `/skill learn`, and related slash
  commands
- TUI also supports `/paste` to queue a copied local file or clipboard image
- Discord supports `!claw` plus slash command equivalents for the same core
  actions

For the full command inventory, keep
[README.md](https://github.com/HybridAIOne/hybridclaw/blob/main/README.md)
open alongside this page.
