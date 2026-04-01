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
hybridclaw config
hybridclaw config check
hybridclaw config reload
hybridclaw config set <key> <value>
hybridclaw config revisions [list|rollback <id>|delete <id>|clear]
hybridclaw browser login [--url <url>]
hybridclaw browser status
hybridclaw browser reset
hybridclaw gateway concierge [info|on|off|model [name]|profile <asap|balanced|no_hurry> [model]]
```

## Auth And Providers

```bash
hybridclaw auth login [provider] ...
hybridclaw auth status <provider>
hybridclaw auth logout <provider>
hybridclaw auth whatsapp reset
hybridclaw local configure <backend> [model-id] [--base-url <url>] [--api-key <key>] [--no-default]
```

## Channel Setup

```bash
hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]
hybridclaw channels imessage setup [--backend <local|remote>] [--allow-from <phone|email|chat:id>]... [--server-url <url>] [--password <password>] [--cli-path <path>] [--db-path <path>] [--webhook-path <path>] [--allow-private-network]
hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...
hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--imap-port <port>] [--imap-secure|--no-imap-secure] [--smtp-host <host>] [--smtp-port <port>] [--smtp-secure|--no-smtp-secure] [--folder <name>]... [--allow-from <email|*@domain|*>]... [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>]
```

## Agents And Packages

```bash
hybridclaw agent list
hybridclaw agent export [agent-id] [-o <path>]
hybridclaw agent inspect <file.claw>
hybridclaw agent install <file.claw|https://.../*.claw|official:<agent-dir>|github:owner/repo[/<ref>]/<agent-dir>> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--skip-import-errors] [--yes]
hybridclaw agent uninstall <agent-id> [--yes]
hybridclaw gateway agent [list|switch <id>|create <id>|model [name]]
```

`agent export` and `agent install` are the primary archive verbs. Legacy
aliases remain accepted: `agent pack` maps to `export`, and `agent unpack`
maps to `install`. Local TUI/web sessions also expose `/agent install <source>`
for the same archive flows against a running gateway.

## Skills, Tools, Plugins, Audit

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
hybridclaw tool list
hybridclaw tool enable <tool-name>
hybridclaw tool disable <tool-name>
hybridclaw plugin list
hybridclaw plugin config <plugin-id> [key] [value|--unset]
hybridclaw plugin enable <plugin-id>
hybridclaw plugin disable <plugin-id>
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

- Local TUI and web chat sessions expose `/config`, `/config check`,
  `/config reload`, `/config set <key> <value>`, `/config revisions`,
  `/concierge`, `/auth status hybridai`, and `/secret list|set|unset|show|route`
  alongside the existing runtime commands
- TUI and chat surfaces use `/agent`, `/agent install`, `/model`, `/mcp`,
  `/plugin`, `/skill`, `/compact`, `/reset`, `/plugin enable`,
  `/plugin disable`, `/plugin install`, `/plugin reinstall`, `/skill import`,
  `/skill learn`, and related slash commands
- TUI also supports `/paste` to queue a copied local file or clipboard image
- Discord supports `!claw` plus slash command equivalents for the same core
  actions

Example secret flow:

```text
/secret set STAGING_HYBRIDAI_API_KEY demo_key_2024
/secret route add https://staging.hybridai.one/api/v1/ STAGING_HYBRIDAI_API_KEY X-API-Key none
```

With that route in place, the model can use `http_request` to call matching
URLs without seeing the plaintext API key.

For the full command inventory, keep
[README.md](https://github.com/HybridAIOne/hybridclaw/blob/main/README.md)
open alongside this page.
