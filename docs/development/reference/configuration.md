---
title: Configuration
description: Runtime files, major config keys, and where HybridClaw stores its state.
sidebar_position: 3
---

# Configuration

HybridClaw creates `~/.hybridclaw/config.json` on first run and hot-reloads
most runtime settings.

## Runtime Files

- `~/.hybridclaw/config.json` for typed runtime config
- `~/.hybridclaw/credentials.json` for runtime secrets
- `~/.hybridclaw/codex-auth.json` for Codex OAuth state
- `~/.hybridclaw/data/hybridclaw.db` for persistent runtime data

HybridClaw does not keep runtime state in the current working directory. If
`./.env` exists, supported secrets are imported once for compatibility.

## Important Config Areas

- `container.*` for sandbox mode, resource limits, networking, and extra binds
- `mcpServers.*` for Model Context Protocol servers
- `sessionReset.*` for daily and idle reset policy
- `sessionRouting.*` for DM continuity scope and linked identities
- `skills.disabled` and `skills.channelDisabled.*` for skill availability
- `plugins.list[]` for plugin overrides and config
- `adaptiveSkills.*` for skill observation, amendment staging, and rollback
- `ops.webApiToken` or `WEB_API_TOKEN` for `/chat`, `/agents`, and `/admin`
- `media.audio` for inbound audio transcription backend selection

## Security Notes

- `mcpServers.*.env` and `mcpServers.*.headers` are currently stored in plain
  text in `config.json`
- keep `~/.hybridclaw/` permissions tight
- prefer low-privilege tokens
- use `host` sandbox mode for stdio MCP servers that depend on host-installed
  tools

For deeper runtime behavior, see [Runtime Internals](../internals/runtime.md).
