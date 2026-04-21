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
- run `mempalace wake-up` and `mempalace search` before prompts when no
  MemPalace MCP server is enabled
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
- If you separately enable a `mempalace` MCP server, the plugin keeps using the
  CLI for startup checks and auto-save mining, but it switches prompt-time
  recall to MCP-oriented guidance instead of injecting CLI `wake-up` and
  `search` output.
- MemPalace features documented outside the CLI, such as the MCP server, the
  19 `mempalace_*` MCP tools, Gemini/Claude hook setup, knowledge-graph tools,
  and diary tools, are not implemented by this HybridClaw plugin itself. If
  you want the MCP tool surface, add the MemPalace MCP server separately.

## Before You Activate It

[MemPalace](https://github.com/milla-jovovich/mempalace) is a free,
open-source local memory system that uses ChromaDB and SQLite for storage with
zero API costs. See the [MemPalace setup guide](https://www.mempalace.tech/guides/setup)
for detailed instructions.

You need an initialized palace before the plugin can do anything useful.
HybridClaw can install the `mempalace` Python package into a plugin-local
environment during `plugin install` if you approve dependency setup, but it
does not initialize a palace or backfill your existing data for you.

Minimal MemPalace setup:

```bash
pip install mempalace
mempalace init ~/projects/myapp
mempalace mine ~/projects/myapp
```

> **Tip:** You can skip the manual `pip install`. Running
> `hybridclaw plugin install ./plugins/mempalace-memory` will offer to install
> `mempalace` into a plugin-local `.venv` automatically. You still need to run
> `mempalace init` and `mempalace mine` yourself.

The important invariant is:

- `mempalace status` must succeed for the palace you actually want to use.
- HybridClaw's `mempalace-memory` plugin must point at that same palace.

If you leave the plugin `palacePath` unset, HybridClaw uses MemPalace's
default palace location, usually `~/.mempalace/palace`. If your real palace is
somewhere else, set `palacePath` explicitly or HybridClaw will search and mine
the wrong palace.

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
hybridclaw plugin install ./plugins/mempalace-memory --yes
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

To avoid ambiguity, setting `palacePath` explicitly is recommended even when
you are using MemPalace's default location.

Reload or restart HybridClaw after changing plugin config:

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

### From a local TUI or web session

`/plugin install` and `/plugin config` are only available from local TUI or web
sessions.

```text
/plugin install ./plugins/mempalace-memory --yes
/plugin enable mempalace-memory
/mempalace status
```

If needed, set the palace location explicitly:

```text
/plugin config mempalace-memory palacePath ~/.mempalace/palace
```

To avoid ambiguity, setting `palacePath` explicitly is recommended even when
you are using MemPalace's default location.

If `mempalace` is not already discoverable from `PATH`, point the plugin at the
binary directly:

```text
/plugin config mempalace-memory command /absolute/path/to/mempalace
/plugin reload
```

## Optional: Add the MemPalace MCP Server

The plugin and the MemPalace MCP server solve different problems:

- the plugin handles automatic `wake-up`, `search`, transcript mining, and
  mirroring of native HybridClaw memory writes
- the MCP server exposes MemPalace's 19 `mempalace_*` tools to the model,
  including taxonomy, knowledge-graph, navigation, and diary tools

If you want those MCP tools in HybridClaw too, add the MemPalace MCP server
separately after installing the plugin.

Once that `mempalace` MCP server is enabled, the plugin automatically prefers
the MCP tool path for prompt-time recall. In other words:

- reads move to MemPalace MCP tools
- CLI `wake-up` and automatic CLI `search` stop being injected into prompts
- CLI-based auto-save and native-memory mirroring continue unchanged

For stdio MCP servers that depend on host binaries, run the gateway in host
sandbox mode first. See [TUI MCP Quickstart](../guides/tui-mcp.md).

Important:

- use absolute paths in MCP config JSON, not `~`
- point the MCP server at the same palace as the plugin
- by default, the plugin looks for an MCP server named `mempalace`
- if you later change plugin `palacePath`, update the MCP server too
- if you use a different MCP server name, set
  `plugin config mempalace-memory mcpServerName <name>` too

### Local TUI or web session

If you installed `mempalace` into the plugin-local `.venv`, add the MCP server
like this:

```text
/mcp add mempalace {"transport":"stdio","command":"/absolute/path/to/.hybridclaw/plugins/mempalace-memory/.venv/bin/python","args":["-m","mempalace.mcp_server"],"env":{"MEMPALACE_PALACE_PATH":"/absolute/path/to/palace"},"enabled":true}
/mcp list
```

Replace the placeholders with real absolute paths on your machine.

If you installed MemPalace into a global Python environment instead of the
plugin-local `.venv`, use that interpreter instead:

```text
/mcp add mempalace {"transport":"stdio","command":"python3","args":["-m","mempalace.mcp_server"],"env":{"MEMPALACE_PALACE_PATH":"/absolute/path/to/palace"},"enabled":true}
```

Expected:

- `/mcp list` shows a `mempalace` stdio server as enabled
- the model can use tools such as
  `mempalace__mempalace_status` and
  `mempalace__mempalace_get_taxonomy`
- `/mempalace status` reports that the configured MCP server is enabled and
  prompt recall is using MCP tools

These are model tools, not slash commands. To use them, ask in normal chat, for
example:

```text
Use MemPalace to show me the current taxonomy of wings and rooms.
```

### Config file alternative

You can also add the same server directly under `mcpServers` in
`~/.hybridclaw/config.json`:

```json
{
  "mcpServers": {
    "mempalace": {
      "transport": "stdio",
      "command": "/absolute/path/to/.hybridclaw/plugins/mempalace-memory/.venv/bin/python",
      "args": ["-m", "mempalace.mcp_server"],
      "env": {
        "MEMPALACE_PALACE_PATH": "/absolute/path/to/palace"
      },
      "enabled": true
    }
  }
}
```

## Local TUI Test Protocol

1. Install the plugin and approve dependency setup:

   ```text
   /plugin install ./plugins/mempalace-memory --yes
   /plugin check mempalace-memory
   ```

   Expected: install succeeds, and `plugin check` shows a usable
   `mempalace` command path. If the binary was installed into the plugin-local
   `.venv`, HybridClaw may configure that path automatically.

2. Apply project-specific config:

   ```text
   /plugin config mempalace-memory palacePath ~/.mempalace/palace
   /plugin config mempalace-memory saveEveryMessages 2
   /plugin reload
   /plugin list
   /plugin check mempalace-memory
   ```

   Expected: `mempalace-memory` shows as loaded, and `plugin check` shows no
   missing dependency or binary issues. Only set `command` manually if
   `plugin check` still cannot find `mempalace`.

3. Smoke-test the manual passthrough:

   ```text
   /mempalace status
   /mempalace wake-up
   /mempalace search "a fact you already know exists in your palace"
   ```

   Expected: `status` succeeds, shows the configured palace path you intended
   to use, `wake-up` returns context, and `search` returns known memories.
   If `status` says `Configured palace path: (not set; using MemPalace
   default...)` or `No palace found ...`, the plugin is not pointed at a ready
   palace yet.

4. Test automatic recall in a normal chat turn.

   Ask a normal question in chat that should match existing MemPalace data,
   for example:

   ```text
   Why did we switch auth providers?
   ```

   Expected: the answer reflects MemPalace recall without you manually running
   `/mempalace search`. If the `mempalace` MCP server is enabled, this should
   happen through the MCP tool path rather than injected CLI search text.

5. Test additive behavior with native HybridClaw memory still active.

   In chat, ask the assistant to store a small fact using its normal memory
   flow:

   ```text
   Remember that my favorite test color is teal.
   ```

   Then ask:

   ```text
   What is my favorite test color?
   ```

   Expected: HybridClaw still remembers it through its built-in memory path.
   MemPalace is layered on top, not replacing native memory.

6. Test automatic MemPalace writeback.

   In chat, send one unique marker:

   ```text
   Remember MP-TUI-2026-04-09-blue-fox
   ```

   Let the assistant reply once, then run:

   ```text
   /mempalace search "MP-TUI-2026-04-09-blue-fox"
   ```

   Expected: the marker is searchable, proving the finished turn was mined
   into MemPalace.

7. Test immediate mirroring of native memory writes.

   After a normal built-in memory write in chat, run a targeted search for the
   same fact:

   ```text
   /mempalace search "favorite test color teal"
   ```

   Expected: the fact is already visible in MemPalace without waiting for a
   long session, because native `memory` writes are mirrored immediately.

8. Run a final health check:

   ```text
   /plugin list
   /plugin check mempalace-memory
   /mempalace status
   ```

   Expected: the plugin is still loaded, `plugin check` still reports a healthy
   dependency setup, and MemPalace still responds.

## How To Use It

Once enabled, the plugin works in the background on every turn:

1. On startup, it runs `mempalace status`.
2. If no enabled `mempalace` MCP server is configured, it optionally runs
   `mempalace wake-up`.
3. If no enabled `mempalace` MCP server is configured, it optionally runs
   `mempalace search` using the latest user message.
4. With CLI recall mode, that MemPalace output is added alongside
   HybridClaw's normal prompt-memory sections for the turn.
5. With MCP recall mode, the plugin injects a short instruction telling the
   model to use the MemPalace MCP tools instead.
6. After turns complete, the plugin buffers recent exchanges in memory.
7. Once the configured threshold is reached, HybridClaw exports the buffered
   transcript batch and runs `mempalace mine <export-dir> --mode convos`.
8. If the session is about to compact, reset, or stop before that threshold is
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

## Quick Setup Checklist

Use this sequence if you want the shortest path to a working setup:

1. Install the plugin and approve dependency setup:

   ```text
   /plugin install ./plugins/mempalace-memory --yes
   ```

2. Make sure MemPalace itself has a real palace with data in it:

   ```bash
   mempalace status
   mempalace search "something you know should already exist"
   ```

3. Point HybridClaw at that same palace:

   ```text
   /plugin config mempalace-memory palacePath ~/.mempalace/palace
   /plugin reload
   ```

4. Verify the plugin is using the expected palace:

   ```text
   /mempalace status
   ```

   Expected: it shows the configured palace path and does not report `No palace
   found`.

5. Verify recall:

   ```text
   /mempalace search "something you know should already exist"
   ```

6. Verify HybridClaw can still use built-in memory and mirror writes into
   MemPalace:

   ```text
   Remember that my favorite test color is teal.
   /mempalace search "favorite test color teal"
   ```

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
          "mcpServerName": "mempalace",
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
- `mcpServerName`: MCP server name to detect for prompt-time MemPalace tool
  usage. Defaults to `mempalace`.
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

## Example Prompts and Use Cases

### Recall past decisions

```text
Why did we switch from REST to GraphQL for the internal API?
```

If this decision was discussed in a prior session and mined into MemPalace,
the plugin surfaces the relevant context before the model answers.

### Store operational knowledge

```text
Remember that the staging deploy requires running database migrations
first, and the deploy key is in the team 1Password vault.
```

The built-in memory stores this immediately, and the plugin mirrors the write
into MemPalace so it is also available through MemPalace search.

### Manual search for specific memories

```text
/mempalace search "auth provider migration"
/mempalace wake-up --wing hybridclaw
```

Use the slash command to inspect raw MemPalace results or wake up context for
a specific wing.

### Full MCP tool access (with MCP server)

```text
Use MemPalace to show me the current taxonomy of wings and rooms.
Use MemPalace to search the knowledge graph for connections between
the auth service and the user service.
```

These require the MemPalace MCP server to be configured separately from the
plugin.

### Cross-tool memory

After a long debugging session, the important conclusions are automatically
mined into MemPalace. In a future session with a different project, those
debugging patterns are still retrievable.

## Tips and Tricks

- **Zero cost, fully local.** MemPalace runs entirely offline after the
  initial model download. No API keys, no cloud accounts, no usage fees.
- **Pin ChromaDB on macOS ARM.** MemPalace can crash with segfaults when
  ChromaDB 1.5.6 is installed on Apple Silicon. If you hit this, downgrade
  with `pip install chromadb==0.6.3` and rebuild. Track upstream fixes in
  [MemPalace issue #100](https://github.com/milla-jovovich/mempalace/issues/100).
- **GPU acceleration.** If you have an NVIDIA GPU, install GPU-accelerated
  `onnxruntime` with CUDA runtime to significantly speed up local embeddings.
  The "GPU device discovery failed" warning from onnxruntime is cosmetic and
  harmless with multi-GPU setups.
- **Large vaults (40k+ drawers).** Unbounded `col.get()` calls can crash with
  too many SQL variables. If your palace is very large, see
  [MemPalace issue #211](https://github.com/milla-jovovich/mempalace/issues/211)
  for batch workarounds.
- **Split large exports.** If your conversation exports are huge concatenated
  files, use `mempalace split` before mining to get better segmentation.
- **Set `palacePath` explicitly.** Even if you use MemPalace's default palace
  location, setting `palacePath` in plugin config avoids confusion when
  multiple palaces exist on the system.
- **Pair with an exclusive provider.** MemPalace is additive, so it can run
  alongside Honcho or ByteRover. Use the exclusive provider for session
  modeling and MemPalace for long-term local search.

## What This Plugin Does Not Do

This plugin is intentionally narrow. It does not:

- initialize a palace or perform first-time project/chat backfills automatically
- disable HybridClaw's built-in canonical, semantic, or file-backed memory
- install or manage the MemPalace MCP server for you
- expose MemPalace's MCP tool names itself; it only detects and prefers them
  when you add that MCP server separately
- install Claude or Gemini save hooks
- mirror MemPalace deletes or reset operations back into HybridClaw
- erase already-mined MemPalace memories when you reset a HybridClaw session

Use MemPalace itself for palace initialization, repair, reset, and other
maintenance. Use this plugin when you want MemPalace to be the active recall
and update path for HybridClaw chat memory.

## Troubleshooting

- **Plugin loads but `mempalace status` says "No palace found":**
  The plugin is not pointed at an initialized palace. Set `palacePath`
  explicitly to the directory where you ran `mempalace init`.

- **Segfault on macOS ARM:**
  ChromaDB version conflict. Run `pip install chromadb==0.6.3` in the plugin's
  `.venv` or your global Python environment.

- **Search returns no results for known facts:**
  Check that you are searching the correct wing. Use
  `/mempalace search "term" --wing <wing>` to narrow the search. Also verify
  that mining has completed with `/mempalace status`.

- **Auto-save is not working:**
  Check `saveEveryMessages` in plugin config (default: 15). The plugin buffers
  turns and only mines after the threshold is reached. Use a lower value for
  testing or run `/mempalace mine` manually.

- **Unicode crashes on Windows:**
  MemPalace CLI uses Unicode characters that can crash on Windows cp1252
  terminals. Use Windows Terminal or set your terminal to UTF-8 encoding.

- **MCP tools not visible:**
  The plugin does not expose MCP tools itself. Add the MemPalace MCP server
  separately. See the "Optional: Add the MemPalace MCP Server" section above.
