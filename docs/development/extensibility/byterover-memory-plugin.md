---
title: ByteRover Memory Plugin
description: Setup, configuration, commands, and runtime behavior for the bundled `byterover-memory` plugin.
sidebar_position: 8
---

# ByteRover Memory Plugin

HybridClaw ships a bundled ByteRover integration at
[`plugins/byterover-memory`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/byterover-memory).

The plugin keeps HybridClaw built-in memory active and adds ByteRover in four
places:

- prompt-time recall through `brv query` using the latest user message
- model tools: `brv_query`, `brv_curate`, and `brv_status`
- a local operator command: `/byterover ...`
- background curation for finished turns, successful native `memory` writes,
  and pre-compaction summaries

Like `honcho-memory`, ByteRover is marked as an external `memoryProvider`.
Only one such plugin can be active at a time, alongside HybridClaw's built-in
`MEMORY.md`, `USER.md`, and SQLite session store.

## Prerequisites

### Install the ByteRover CLI

The plugin shells out to the `brv` CLI. Install it before enabling the plugin:

```bash
npm install -g byterover-cli
# or
curl -fsSL https://byterover.dev/install.sh | sh
```

Verify the installation:

```bash
brv --version
```

For alternative installation methods, see the
[ByteRover CLI repository](https://github.com/campfirein/byterover-cli) and
the [ByteRover documentation](https://docs.byterover.dev).

> **Tip:** You can skip the manual install. Running
> `hybridclaw plugin install ./plugins/byterover-memory` will offer to install
> `byterover-cli` as a local npm dependency inside the plugin directory
> automatically.

### Initialize the Context Tree

ByteRover stores its Context Tree relative to the directory where you run
`brv`. The HybridClaw plugin uses `workingDirectory` in its config (default:
`~/.hybridclaw/byterover`) as the working directory for all `brv` calls.

ByteRover is directory-scoped — the Context Tree lives in `.brv/` relative to
where you run `brv`. Choose one of these two setups:

### Option A: Project-scoped (recommended)

The plugin and your shell both use the same project directory. No extra config
needed — `brv query` from the project root and `/byterover query` in TUI hit
the same context tree.

```bash
cd ~/src/my-project
brv
```

Then point the plugin at the same directory:

```text
/plugin config byterover-memory workingDirectory ~/src/my-project
```

### Option B: Global memory

A single context tree shared across all projects, stored in the plugin's
default directory. Good for cross-project knowledge like personal preferences
and general decisions.

```bash
mkdir -p ~/.hybridclaw/byterover
cd ~/.hybridclaw/byterover
brv
```

No plugin config change needed — `~/.hybridclaw/byterover` is the default
`workingDirectory`. When querying from the shell, remember to `cd` there
first:

```bash
cd ~/.hybridclaw/byterover && brv query auth
```

### First launch (both options)

ByteRover auto-configures on first launch. Inside the `brv` interactive REPL,
it will prompt you to:

1. **Select an LLM provider** — choose from 18 supported providers or use
   ByteRover's built-in option. You need an API key for your chosen provider.
2. **Pick a model** — ByteRover prompts you to select after provider setup.

After the initial setup, curate some initial context inside the `brv` REPL so
the Context Tree is not empty:

```text
brv> /curate This project uses TypeScript and PostgreSQL.
```

Then exit the REPL and verify the setup from your normal shell:

```bash
brv status
```

Expected: `Context Tree: Initialized` and a non-empty `.brv/context-tree/`
directory.

### Local vs Cloud

ByteRover works in two modes:

- **Local (default)**: the Context Tree is stored in `.brv/context-tree/` as
  human-readable markdown files. No account or API key required. All queries
  and curation happen locally through your configured LLM provider.
- **Cloud sync (optional)**: with a `BRV_API_KEY`, you can push your Context
  Tree to ByteRover's cloud for backup, cross-machine sync, and team sharing.
  Cloud sync is always explicit through `brv push` — nothing leaves your
  machine unless you choose to push. Optionally initialize version control
  with `brv vc init` for Git-based tracking of your Context Tree.

For local-only use, just install the CLI and initialize. For cloud sync, sign
up at [byterover.dev](https://byterover.dev) and set your API key (see below).

## HybridClaw Setup

### Install the plugin

```bash
hybridclaw plugin install ./plugins/byterover-memory
```

If `brv` is not yet on your `PATH`, the installer will offer to install
`byterover-cli` as a local npm dependency inside the plugin directory.

### From a local TUI or web session

```text
/plugin install ./plugins/byterover-memory --yes
/plugin enable byterover-memory
/byterover status
```

Both `/plugin install` and `/plugin enable` automatically reload the plugin
runtime — no separate `/plugin reload` is needed.

### Set credentials (optional)

For cloud sync, store the ByteRover API key through HybridClaw secrets:

```text
/secret set BRV_API_KEY your-byterover-key
```

The key is optional. Without it, ByteRover runs in local-first mode.

### Verify

```text
/plugin list
/plugin check byterover-memory
/byterover status
/show tools
```

Expected: `byterover-memory` shows as enabled, `brv` resolves, `/byterover
status` responds, and `brv_query`, `brv_curate`, `brv_status` appear in the
tool list.

## Recommended Config

The plugin works with defaults after install. A small explicit config for
regular use:

```json
{
  "plugins": {
    "list": [
      {
        "id": "byterover-memory",
        "enabled": true,
        "config": {
          "command": "brv",
          "workingDirectory": "~/.hybridclaw/byterover",
          "autoCurate": true,
          "mirrorMemoryWrites": true,
          "maxInjectedChars": 4000,
          "queryTimeoutMs": 30000,
          "curateTimeoutMs": 120000
        }
      }
    ]
  }
}
```

Supported config keys:

- `command`: ByteRover executable to spawn. Defaults to `brv`.
- `workingDirectory`: cwd used for every `brv` invocation. Defaults to
  `<runtime-home>/byterover`, so the knowledge tree is profile-scoped rather
  than repo-scoped.
- `autoCurate`: when `true`, queue `brv curate` after completed assistant
  turns. Defaults to `true`.
- `mirrorMemoryWrites`: when `true`, mirror successful native `memory` writes
  into ByteRover as labeled curations. Defaults to `true`.
- `maxInjectedChars`: prompt budget for auto-injected ByteRover recall.
  Defaults to `4000`.
- `queryTimeoutMs`: timeout for prompt recall, `brv_query`, and
  `/byterover query`. Defaults to `30000`. ByteRover queries involve LLM
  calls against the context tree, so they need more time than a simple search.
- `curateTimeoutMs`: timeout for queued and explicit `brv curate` calls.
  Defaults to `120000`.

## Commands and Tools

### Slash command

```text
/byterover status
/byterover query auth migration
/byterover curate Remember that concise answers are preferred.
```

The command is a direct CLI passthrough with `status` as the default when no
subcommand is given.

### Model tools

| Tool | Description |
| --- | --- |
| `brv_status` | Show CLI health, working directory, and whether `BRV_API_KEY` is configured |
| `brv_query` | Search ByteRover memory for relevant prior knowledge |
| `brv_curate` | Explicitly store durable facts, decisions, or preferences |

### Behavior

- Before each turn, the plugin runs `brv query -- <latest-user-message>`.
- If ByteRover returns usable text, that recall is injected into prompt context
  as current-turn external memory.
- The plugin also injects a short tool-use guide so the model knows when to use
  `brv_query`, `brv_curate`, and `brv_status`.
- After a completed turn, the plugin queues a `brv curate` call with a compact
  `User:` / `Assistant:` summary.
- Successful native `memory` writes are mirrored into ByteRover with labels
  such as `User profile` or `Durable memory`.
- Before compaction, the plugin curates the compaction summary plus a few recent
  user/assistant excerpts so older context is not lost before SQLite archival.
- All ByteRover calls run on the gateway host process, not inside the agent
  container.

## Example Prompts and Use Cases

### Store project decisions

```text
We decided to use PostgreSQL instead of MongoDB for the user service.
The migration is planned for Q3 and will require schema changes in
three microservices.
```

ByteRover automatically curates this into its Context Tree after the turn
completes. In a later session, asking about the user service database will
surface this decision.

### Cross-session recall

```text
What do we know about the auth migration?
```

The plugin queries ByteRover before the turn and injects relevant prior context
into the prompt. The model answers using both session history and ByteRover
recall.

### Explicit curation

```text
Use brv_curate to remember: deploy to staging requires VPN access
and the deploy key from 1Password under "Staging Deploy Key".
```

This stores the fact explicitly rather than waiting for background curation.

### Debug what ByteRover knows

```text
/byterover query deployment process
/byterover status
```

Use the slash command to inspect raw ByteRover output without going through the
model.

### Pre-compaction preservation

Long sessions that trigger compaction automatically curate a summary into
ByteRover before the older messages are archived. This means important context
from early in a long session is preserved even after compaction discards the
original messages.

## Tips and Tricks

- **Context Tree is git-friendly.** The `.brv/context-tree/` directory contains
  plain markdown files organized as Domains > Topics > Context Files. You can
  commit them to version control, review changes in PRs, and share across
  machines without cloud sync.
- **Start local, add cloud later.** The local-first mode requires no account
  and works fully offline. Add `BRV_API_KEY` later when you want cross-machine
  sync or team sharing.
- **Use `brv restart` when stuck.** If ByteRover becomes unresponsive or hangs
  after an update, `brv restart` clears the process state. Run it from the
  shell, not through `/byterover`.
- **CI and automation.** Use `--headless --format json` flags for
  machine-parseable output in scripts and CI pipelines.
- **Mind the working directory.** The `workingDirectory` config controls where
  the Context Tree lives. The default is profile-scoped
  (`~/.hybridclaw/byterover`), not repo-scoped. Set it explicitly if you want
  per-project knowledge trees.
- **No data leaves your machine by default.** Cloud sync only happens through
  explicit `brv push`. The plugin never pushes automatically.
- **Logging out preserves local data.** Running `brv logout` only clears cloud
  credentials. Your local Context Tree is untouched.
- **Pair with built-in memory.** Use HybridClaw's `MEMORY.md` for fast
  operational notes and session-local preferences. Use ByteRover for durable
  knowledge that should survive across projects and sessions.

## Troubleshooting

- **Plugin loads but no tools appear:**
  Check `/byterover status`. If the `brv` binary is not found, set `command`
  to the full path or ensure it is on `PATH` for the gateway process.

- **No prompt recall appears:**
  The plugin only injects recall when `brv query` returns non-empty results.
  Curate some facts first, then verify with `/byterover query <term>`.

- **Another memory provider is already active:**
  ByteRover is marked `memoryProvider: true`. Only one exclusive provider can
  be active. Disable the other plugin first (e.g., `honcho-memory`).

- **Query timeouts (`/byterover query` or `brv_query`):**
  ByteRover queries involve LLM calls against the context tree and can take
  15-25 seconds depending on your provider. If you see timeout errors,
  increase `queryTimeoutMs` (default: 30000):

  ```text
  /plugin config byterover-memory queryTimeoutMs 60000
  ```

- **Slow curation or timeouts:**
  Background `brv curate` runs through your LLM provider. If your provider is
  slow, increase `curateTimeoutMs` or check your provider configuration.

- **Context Tree is empty after many sessions:**
  Check that `autoCurate` is `true` (the default). Also verify that
  `workingDirectory` points where you expect — the tree might be in a different
  directory.

- **`brv query` from the shell finds nothing, but TUI recall works:**
  ByteRover is directory-scoped. The plugin uses `workingDirectory` (default:
  `~/.hybridclaw/byterover`) for all `brv` calls, but running `brv query`
  from your shell uses the current directory. To query the same tree the plugin
  uses, either `cd` to the working directory first or pass `--dir`:

  ```bash
  cd ~/.hybridclaw/byterover && brv query auth
  ```

  Alternatively, set the plugin's `workingDirectory` to your project directory
  so both the plugin and your shell use the same context tree.

- **Cloud sync issues:**
  Run `brv status` from the shell to check cloud connectivity. Verify your
  `BRV_API_KEY` with `/secret list`. Remember that sync is explicit through
  `brv push`, not automatic.
