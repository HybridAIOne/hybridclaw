---
title: MemPalace Memory Plugin
description: User guide for activating and using the bundled `mempalace-memory` plugin with a local MemPalace installation.
sidebar_position: 6
---

# MemPalace Memory Plugin

HybridClaw ships an installable MemPalace plugin source at
[`plugins/mempalace-memory`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/mempalace-memory).

This plugin connects HybridClaw to an existing local MemPalace CLI installation
and adds MemPalace recall and auto-save on top of HybridClaw's built-in memory
for normal chat turns. With the plugin enabled, HybridClaw can:

- run `mempalace status` as a startup health check
- run `mempalace wake-up` before prompts to inject MemPalace wake-up context
- run `mempalace search "<latest user question>"` before prompts to recall
  relevant memories
- buffer recent HybridClaw turns and periodically run
  `mempalace mine ... --mode convos` so new turns are written back into
  MemPalace automatically
- mirror successful native `memory` tool writes into MemPalace immediately
  through a dedicated plugin hook bridge
- flush any buffered-but-not-yet-mined turns before session compaction,
  session reset, and gateway shutdown
- expose a `/mempalace ...` command for manual MemPalace CLI access in local
  TUI and web sessions

HybridClaw still stores the raw chat transcript in its own database for session
history and UI features, and it continues using HybridClaw's built-in
canonical, semantic, and compaction-based prompt memory. MemPalace context is
layered in alongside that native memory path.

## What HybridClaw Implements

MemPalace documents these primary CLI commands: `init`, `split`, `mine`,
`search`, `wake-up`, `status`, `repair`, and `compress`.

HybridClaw integrates them in two different ways:

| MemPalace command | Used automatically by plugin | Available through `/mempalace ...` | Notes |
| --- | --- | --- | --- |
| `status` | Yes | Yes | Used as the plugin startup health check |
| `wake-up` | Yes | Yes | Injected into prompt context before a turn |
| `search` | Yes | Yes | Queried with the latest user message before a turn |
| `init` | No | Yes | Use for initial MemPalace setup |
| `mine` | Yes | Yes | Used automatically by plugin auto-save hooks; also available manually |
| `split` | No | Yes | Useful before mining concatenated transcript exports |
| `repair` | No | Yes | Available only as manual passthrough |
| `compress` | No | Yes | Available only as manual passthrough |

Important distinction:

- The plugin's automatic memory behavior depends on `status`, `wake-up`,
  `search`, and `mine`.
- The `/mempalace` command is a generic CLI passthrough, so it can forward
  other MemPalace subcommands too.
- MemPalace features documented outside the CLI, such as the MCP server, the
  19 `mempalace_*` MCP tools, Gemini/Claude hook setup, knowledge-graph tools,
  and diary tools, are not implemented by this HybridClaw plugin.

## Before You Activate It

Install and initialize MemPalace first. The plugin expects a working
`mempalace` executable and an existing palace.

Minimal MemPalace setup:

```bash
pip install mempalace
mempalace init ~/projects/myapp
mempalace mine ~/projects/myapp
```

If your memories come from chats instead of source code, MemPalace also
documents:

```bash
mempalace mine ~/chats --mode convos
```

You can confirm that MemPalace itself is ready before enabling the plugin:

```bash
mempalace status
```

## Activate The Plugin

### From the CLI

Install the plugin:

```bash
hybridclaw plugin install ./plugins/mempalace-memory
```

If `mempalace` is already on your `PATH`, no extra config is required. If not,
point the plugin at the executable explicitly:

```bash
hybridclaw plugin config mempalace-memory command /absolute/path/to/mempalace
```

If your palace is not at MemPalace's default location, configure that too:

```bash
hybridclaw plugin config mempalace-memory palacePath ~/.mempalace/palace
```

Reload or restart HybridClaw after changing plugin config:

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

### From a local TUI or web session

`/plugin install` and `/plugin config` are only available from local TUI or web
sessions.

```text
/plugin install ./plugins/mempalace-memory
/plugin config mempalace-memory command mempalace
/plugin reload
```

If needed:

```text
/plugin config mempalace-memory palacePath ~/.mempalace/palace
/plugin reload
```

## Verify That It Is Working

1. Check plugin state:

   ```text
   /plugin list
   ```

   If the `mempalace` binary is missing, HybridClaw marks the plugin as failed
   and reports the missing required binary instead of loading it.

2. Run the passthrough command manually:

   ```text
   /mempalace status
   ```

3. Ask a question that should hit existing memories.

4. If you want to probe retrieval directly, run:

   ```text
   /mempalace wake-up
   /mempalace search "why did we switch auth providers?"
   ```

## How To Use It

Once enabled, the plugin works in the background on every turn:

1. On startup, it runs `mempalace status`.
2. Before a prompt, it optionally runs `mempalace wake-up`.
3. It then optionally runs `mempalace search` using the latest user message.
4. That MemPalace output is added alongside HybridClaw's normal prompt-memory
   sections for the turn.
5. After turns complete, the plugin buffers recent exchanges in memory.
6. Once the configured threshold is reached, HybridClaw exports the buffered
   transcript batch and runs `mempalace mine <export-dir> --mode convos`.
7. If the session is about to compact, reset, or stop before that threshold is
   reached, the plugin flushes the pending buffer early through plugin hooks.

This means normal usage is just asking HybridClaw questions. You do not need to
manually run `/mempalace search ...` or `/mempalace mine ...` on every turn.

Manual commands are still useful for debugging and maintenance:

```text
/mempalace status
/mempalace wake-up --wing hybridclaw
/mempalace search "auth migration" --wing hybridclaw
/mempalace mine ~/exports/chats --mode convos
```

The last example works because `/mempalace` forwards arbitrary MemPalace CLI
arguments, but mining and repair operations are still MemPalace operations, not
native HybridClaw features.

## Recommended Config

If you want tighter retrieval around one project or palace wing, add a
`plugins.list[]` override:

```json
{
  "plugins": {
    "list": [
      {
        "id": "mempalace-memory",
        "enabled": true,
        "config": {
          "command": "mempalace",
          "palacePath": "~/.mempalace/palace",
          "sessionExportDir": ".hybridclaw/mempalace-turns",
          "wakeUpWing": "hybridclaw",
          "searchWing": "hybridclaw",
          "updateWing": "hybridclaw",
          "updateAgent": "hybridclaw",
          "saveEveryMessages": 15,
          "maxResults": 3,
          "maxWakeUpChars": 1200,
          "maxSearchChars": 2800,
          "maxInjectedChars": 4000,
          "timeoutMs": 12000
        }
      }
    ]
  }
}
```

Supported config keys:

- `command`: path to the MemPalace executable. Defaults to `mempalace`.
- `workingDirectory`: cwd used when HybridClaw spawns MemPalace.
- `palacePath`: optional override for `--palace`.
- `sessionExportDir`: where HybridClaw writes buffered conversation exports
  before mining them into MemPalace.
- `wakeUpEnabled`: enable or disable automatic `wake-up` injection.
- `wakeUpWing`: optional wing passed to `mempalace wake-up --wing ...`.
- `searchEnabled`: enable or disable automatic search injection.
- `searchWing`: optional wing filter for automatic search.
- `searchRoom`: optional room filter for automatic search.
- `updateWing`: optional wing used for automatic `mine --mode convos` updates.
  If omitted, the plugin falls back to `wakeUpWing`, then `searchWing`, then
  the active HybridClaw agent id.
- `updateAgent`: name recorded in MemPalace metadata for automatic updates.
- `saveEveryMessages`: auto-save threshold for buffered transcript mining.
  Defaults to `15`, matching MemPalace's hook tutorial cadence.
- `maxResults`: number of search hits requested from MemPalace.
- `maxWakeUpChars`: cap for retained `wake-up` output.
- `maxSearchChars`: cap for retained search output.
- `maxInjectedChars`: total prompt budget for injected MemPalace context.
- `timeoutMs`: timeout for `status`, `wake-up`, and automatic search calls. The
  plugin gives `mine` a longer minimum timeout automatically.

## What This Plugin Does Not Do

This plugin is intentionally narrow. It does not:

- install MemPalace itself
- initialize a palace or perform first-time project/chat backfills automatically
- disable HybridClaw's built-in canonical, semantic, or file-backed memory
- run `python -m mempalace.mcp_server`
- expose MemPalace's MCP tool names such as `mempalace_search`
- install Claude or Gemini save hooks
- mirror MemPalace deletes or reset operations back into HybridClaw
- erase already-mined MemPalace memories when you reset a HybridClaw session

Use MemPalace itself for palace initialization, repair, reset, and other
maintenance. Use this plugin when you want MemPalace to be the active recall
and update path for HybridClaw chat memory.
