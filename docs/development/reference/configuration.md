---
title: Configuration
description: Runtime files, major config keys, and where HybridClaw stores its state.
sidebar_position: 3
---

# Configuration

HybridClaw creates `~/.hybridclaw/config.json` on first run and hot-reloads
most runtime settings.

Use `hybridclaw config` to print the active runtime config,
`hybridclaw config check` to validate only the config file itself,
`hybridclaw config reload` to force an immediate in-process hot reload from
disk, `hybridclaw config set <key> <value>` to edit an existing dotted key
path without rewriting the whole file manually, and
`hybridclaw config revisions [list|rollback <id>|delete <id>|clear]` to audit
or restore tracked config snapshots.

## Runtime Files

- `~/.hybridclaw/config.json` for typed runtime config
- `~/.hybridclaw/credentials.json` for encrypted runtime secrets
- `~/.hybridclaw/credentials.master.key` for the local owner-only fallback
  master key when no external key source is configured
- `~/.hybridclaw/codex-auth.json` for Codex OAuth state
- `~/.hybridclaw/data/hybridclaw.db` for persistent runtime data
- `~/.hybridclaw/data/config-revisions.db` for tracked runtime config history

HybridClaw does not keep runtime state in the current working directory. If
`./.env` exists, supported secrets are imported once for compatibility.
Headless or containerized deployments should prefer `HYBRIDCLAW_MASTER_KEY` or
`/run/secrets/hybridclaw_master_key` instead of the local fallback key file.

## Config Revision History

HybridClaw records runtime config snapshots whenever `config.json` changes
through the CLI, gateway commands, or background reload paths.

- `hybridclaw config revisions` lists tracked snapshots with actor, route,
  timestamp, and content hash metadata
- `hybridclaw config revisions rollback <id>` restores one saved snapshot back
  into `config.json`
- `hybridclaw config revisions delete <id>` removes one saved snapshot
- `hybridclaw config revisions clear` deletes the stored history for the active
  config file

Tracked routes are sanitized before storage so host-specific home paths do not
leak into the saved revision metadata.

## Important Config Areas

- `container.*` for sandbox mode, resource limits, networking, and extra binds
- `observability.*` for HybridAI audit-event forwarding, ingest batching, and
  runtime status reporting
- `hybridai.baseUrl` for the HybridAI API origin; `HYBRIDAI_BASE_URL` can
  override it for the current process without rewriting `config.json`
- `hybridai.maxTokens` for the default completion output budget; the shipped
  default is `4096`
- `mcpServers.*` for Model Context Protocol servers
- `sessionReset.*` for daily and idle reset policy
- `sessionRouting.*` for DM continuity scope and linked identities
- `skills.disabled` and `skills.channelDisabled.*` for skill availability
- `plugins.list[]` for plugin overrides and config
- `adaptiveSkills.*` for skill observation, amendment staging, and rollback
- `imessage.*` for the dual-backend local or BlueBubbles iMessage transport
- `ops.webApiToken` or `WEB_API_TOKEN` for `/chat`, `/agents`, and `/admin`
- `media.audio` for inbound audio transcription backend selection

## Security Notes

- `mcpServers.*.env` and `mcpServers.*.headers` are currently stored in plain
  text in `config.json`
- In `host` sandbox mode, the agent can access the user home directory, the
  gateway working directory, `/tmp`, and any host paths explicitly added
  through `container.binds` or `container.additionalMounts`
- keep `~/.hybridclaw/` permissions tight (`0700` on the directory, `0600` on
  secret-bearing files)
- prefer low-privilege tokens
- use `host` sandbox mode for stdio MCP servers that depend on host-installed
  tools

For deeper runtime behavior, see [Runtime Internals](../internals/runtime.md).
