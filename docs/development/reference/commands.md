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
hybridclaw gateway <command...>
hybridclaw gateway compact
hybridclaw gateway reset [yes|no]
hybridclaw tui
hybridclaw tui --resume <sessionId>
hybridclaw --resume <sessionId>
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
hybridclaw update [status|--check] [--yes]
hybridclaw help
```

`hybridclaw gateway <command...>` forwards a command to a running gateway, for
example `sessions` or `bot info`.
`gateway compact` archives older session history into memory while preserving a
recent active tail, and `gateway reset [yes|no]` clears history plus the
current workspace after confirmation.
`hybridclaw tui --resume <sessionId>` and `hybridclaw --resume <sessionId>`
reopen an earlier TUI session by canonical session id.

## Auth And Providers

```bash
hybridclaw auth login [provider] ...
hybridclaw auth status <provider>
hybridclaw auth logout <provider>
hybridclaw auth whatsapp reset
hybridclaw auth login msteams [--app-id <id>] [--app-password <secret>] [--tenant-id <id>]
hybridclaw local status
hybridclaw local configure <backend> [model-id] [--base-url <url>] [--api-key <key>] [--no-default]
hybridclaw help auth
hybridclaw help openrouter
hybridclaw help mistral
hybridclaw help huggingface
```

`auth status` supports `hybridai`, `codex`, `openrouter`, `mistral`,
`huggingface`, `local`, and `msteams`.
Legacy aliases such as `hybridclaw hybridai ...`, `hybridclaw codex ...`, and
`hybridclaw local ...` still work, but `auth` is the primary surface.

## Channel Setup

```bash
hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]
hybridclaw channels imessage setup [--backend <local|remote>] [--allow-from <phone|email|chat:id>]... [--server-url <url>] [--password <password>] [--cli-path <path>] [--db-path <path>] [--webhook-path <path>] [--allow-private-network]
hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...
hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--imap-port <port>] [--imap-secure|--no-imap-secure] [--smtp-host <host>] [--smtp-port <port>] [--smtp-secure|--no-smtp-secure] [--folder <name>]... [--allow-from <email|*@domain|*>]... [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>]
hybridclaw auth login msteams [--app-id <id>] [--app-password <secret>] [--tenant-id <id>]
```

Microsoft Teams setup uses `auth login` instead of `channels setup` because it
needs app credentials and a webhook handoff instead of a pairing flow. For the
step-by-step setup guide, see [Getting Started: Channel Setup](../getting-started/channels.md).
Local TUI/web sessions can also write channel config and secrets with
`/config set ...` and `/secret set ...`; see the same guide for channel-specific
examples and current CLI-only limitations such as WhatsApp pairing.

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
For archive flags such as `--description`, `--author`, skill/plugin bundling,
and GitHub install sources, see
[Agent Packages](../extensibility/agent-packages.md).

## Migration

```bash
hybridclaw migrate openclaw [--source <path>] [--agent <id>] [--dry-run] [--overwrite] [--migrate-secrets] [--force]
hybridclaw migrate hermes [--source <path>] [--agent <id>] [--dry-run] [--overwrite] [--migrate-secrets] [--force]
```

Use these commands to import compatible state from `~/.openclaw` or
`~/.hermes` into a HybridClaw agent workspace. `--dry-run` previews the
workspace, config, model, and secret changes before writing anything.

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
hybridclaw update [status|--check] [--yes]
hybridclaw audit recent
hybridclaw audit approvals [n] [--denied]
hybridclaw audit search <query>
hybridclaw audit verify [sessionId]
hybridclaw audit instructions [--sync]
```

`skill import [--force] [--skip-skill-scan]` supports packaged `official/<skill-name>` sources plus
community imports from `skills-sh`, `clawhub`, `lobehub`,
`claude-marketplace`, `well-known`, and explicit GitHub repo/path refs.
`update` checks for a newer installed release and can upgrade a global npm
install; source checkouts receive git-based update instructions instead.

## Discord And Session Commands

Discord supports `!claw` plus slash-command equivalents for the same core
actions. Common examples:

```text
!claw <message>
/agent
/agent list
/agent switch <id>
/agent create <id> [--model <model>]
/agent model [name]
!claw bot set <id>
!claw model set <name>
!claw model clear
!claw model info
!claw rag on
!claw compact
/reset
!claw clear
!claw audit recent [n]
!claw audit verify [sessionId]
!claw audit search <query>
!claw audit approvals [n] [--denied]
!claw usage [summary|daily|monthly|model [daily|monthly] [agentId]]
!claw export session [sessionId]
!claw export trace [sessionId|all]
!claw mcp list
!claw mcp add <name> <json>
!claw schedule add "<cron>" <prompt>
!claw schedule add at "<ISO time>" <prompt>
!claw schedule add every <ms> <prompt>
```

`/agent`, `/model`, `/reset`, `/mcp`, and related slash commands route through
the same gateway command surface used by TUI and web chat.

## In Session

- Local TUI and web chat sessions expose `/config`, `/config check`,
  `/config reload`, `/config set <key> <value>`, `/config revisions`,
  `/concierge`, `/auth status hybridai`, and `/secret list|set|unset|show|route`
  alongside the existing runtime commands
- TUI and chat surfaces use `/agent`, `/agent install`, `/model`, `/mcp`,
  `/plugin`, `/skill`, `/compact`, `/reset`, `/plugin enable`,
  `/plugin disable`, `/plugin install`, `/plugin reinstall`, `/plugin reload`,
  `/skill import`, `/skill learn`, `/schedule`, `/status`, and related slash
  commands
- TUI also supports `/paste` to queue a copied local file or clipboard image
- TUI `/skill config` opens the interactive skill availability checklist
- `/status` shows both the current session and current agent
- `/compact` runs session compaction, and `/reset` runs the confirmed
  workspace reset flow
- `/plugin ...` manages runtime plugins, and `/mcp ...` manages runtime MCP
  servers
- `/auth status hybridai` shows local HybridAI auth and config state
- Typing `/` in the TUI opens the slash-command menu with inline filtering and
  help aliases
- The TUI startup banner summarizes the active model, sandbox, gateway,
  provider, and chatbot context before the first prompt
- pressing `Up` or `Down` on an empty prompt recalls earlier prompts
- press `Ctrl-C` or `Ctrl-D` twice within five seconds to exit the TUI
- on exit, HybridClaw prints token/file/tool totals and a ready-to-run
  `hybridclaw tui --resume <sessionId>` command for that session

Example secret flow:

```text
/secret set STAGING_HYBRIDAI_API_KEY demo_key_2024
/secret route add https://staging.hybridai.one/api/v1/ STAGING_HYBRIDAI_API_KEY X-API-Key none
```

With that route in place, the model can use `http_request` to call matching
URLs without seeing the plaintext API key.
