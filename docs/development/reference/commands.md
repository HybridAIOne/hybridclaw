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
hybridclaw agent install <file.claw> [--id <id>] [--force] [--skip-externals] [--yes]
hybridclaw agent uninstall <agent-id> [--yes]
hybridclaw gateway agent [list|switch <id>|create <id>|model [name]]
```

## Skills, Plugins, Audit

```bash
hybridclaw skill list
hybridclaw skill enable <skill-name> [--channel <kind>]
hybridclaw skill inspect <skill-name>
hybridclaw plugin list
hybridclaw plugin config <plugin-id> [key] [value|--unset]
hybridclaw plugin install <path|npm-spec>
hybridclaw plugin reinstall <path|npm-spec>
hybridclaw plugin uninstall <plugin-id>
hybridclaw audit recent
hybridclaw audit search <query>
hybridclaw audit verify [sessionId]
```

## In Session

- TUI and chat surfaces use `/agent`, `/model`, `/mcp`, `/plugin`, `/skill`,
  `/compact`, `/reset`, and related slash commands
- Discord supports `!claw` plus slash command equivalents for the same core
  actions

For the full command inventory, keep [README.md](../../../README.md) open
alongside this page.
