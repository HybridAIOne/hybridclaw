---
title: QMD Memory Plugin
description: Setup and behavior for the external markdown-search memory layer shipped as the `qmd-memory` plugin.
sidebar_position: 6
---

# QMD Memory Plugin

HybridClaw ships an installable QMD memory plugin source at
[`plugins/qmd-memory`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/qmd-memory).
The plugin complements the built-in SQLite session memory with external QMD
search over markdown notes, docs, and optional exported session transcripts.

## Install

1. Install QMD separately. The plugin shells out to the `qmd` CLI and does not
   embed QMD as a library.
2. Install the plugin from this repo:

   ```bash
   hybridclaw plugin install ./plugins/qmd-memory
   ```

   The plugin declares a required `qmd` executable. If neither `qmd` nor a
   configured `command` override is available, HybridClaw leaves the plugin
   disabled and reports the missing binary in `/plugin list`.

3. Reload plugins in an active session:

   ```text
   /plugin reload
   ```

   To switch the QMD retrieval mode from the TUI without editing JSON
   directly, you can also run:

   ```text
   /plugin config qmd-memory searchMode query
   ```

## Config

Add an override in `plugins.list[]` when you want non-default behavior:

```json
{
  "plugins": {
    "list": [
      {
        "id": "qmd-memory",
        "enabled": true,
        "config": {
          "searchMode": "query",
          "maxResults": 10,
          "maxSnippetChars": 600,
          "maxInjectedChars": 4000,
          "sessionExport": false
        }
      }
    ]
  }
}
```

Supported config keys:

- `command`: QMD executable to spawn. Defaults to `qmd`.
  This value is executed directly as a child process of the gateway, so treat
  it as trusted operator configuration only. Pointing it at a different binary
  lets that executable run with the same OS user and filesystem access as the
  HybridClaw gateway process.
- `workingDirectory`: directory used as the QMD process cwd. Defaults to the
  HybridClaw runtime cwd.
- `searchMode`: `search`, `vsearch`, or `query`. Defaults to `query`.
- `maxResults`: max QMD hits to format into prompt context.
- `maxSnippetChars`: per-result snippet/context cap before formatting.
- `maxInjectedChars`: total prompt context budget for injected QMD results.
- `timeoutMs`: timeout for background prompt searches and `qmd status`.
  Explicit passthrough commands use a separate larger fixed timeout.
- `sessionExport`: when `true`, rewrite the current session transcript as
  markdown after each turn.
- `sessionExportDir`: optional override for transcript exports. Defaults to
  `<workingDirectory>/.hybridclaw/qmd-sessions`.

## Behavior

- Before each turn, the plugin searches QMD with the latest user message and
  injects the top matching snippets into prompt context.
- Injected QMD hits are external indexed context. They may refer to files that
  are not present in the agent workspace, so the model should answer from those
  snippets instead of treating the source path as a missing local file.
- Retrieved QMD hits are injected as a separate current-turn retrieval section,
  not as part of the generic session-memory summary.
- On search failure or missing `qmd`, the plugin logs a warning and falls back
  to no extra context.
- When `sessionExport` is enabled, HybridClaw writes one markdown file per
  session so QMD can index past conversations as a normal collection.
- Diagnostics are available through `qmd status`.
- Other QMD CLI subcommands can be passed through from the TUI or gateway, for
  example `qmd collection add .`.
- Explicit passthrough commands such as `qmd embed` use a separate 15 minute
  timeout rather than the short background search timeout.

## How-To

### Switch QMD to natural-language retrieval

```text
/plugin config qmd-memory searchMode query
/plugin reload
/qmd status
```

`/qmd status` should then show `Search mode: query`.

### Index the current repo and build embeddings

```text
/qmd collection add .
/qmd embed
/qmd status
```

`collection add` indexes markdown files. `embed` generates vectors for hybrid
or vector retrieval. Depending on your local QMD setup, the first `embed` or
`query` run may download models.

### Reinstall the plugin after editing repo source

```text
/plugin reinstall ./plugins/qmd-memory
/plugin reload
```

The installed plugin lives under `~/.hybridclaw/plugins/qmd-memory`, so reload
alone does not pick up repo edits.

## Tips & Tricks

- Prefer `query` for natural-language prompts. It is the default and uses QMD's
  hybrid expansion/reranking path.
- Use `search` for fast lexical debugging when you want to test keyword hits
  directly.
- Use `vsearch` only when embeddings are already built and you want vector-only
  behavior.
- If a broad prompt misses, try the underlying lexical probe directly with a
  condensed query such as `plugins skills` to distinguish retrieval quality
  from prompt wording.
- `/qmd embed` is an explicit passthrough command and can run much longer than
  the short background-search timeout.

## Verifying Retrieval

To verify that the plugin is both loaded and actively contributing context:

1. Check the active mode:

   ```text
   /qmd status
   ```

   The status output shows the effective `Search mode`. For natural-language
   prompt retrieval, prefer `query`.

2. Ask a prompt that should hit indexed docs.

3. Confirm the result path:

   - The TUI footer shows `🪼 plugins: qmd-memory` when a reply used
     plugin-provided prompt context.
   - The saved prompt dump at
     `~/.hybridclaw/data/last_prompt.jsonl` contains both
     `## Retrieved Context` and
     `External QMD knowledge search results:` when QMD retrieval was injected.

If `/plugin list` shows the plugin as enabled but the prompt dump lacks the
retrieval section, the plugin loaded but QMD returned no usable matches for
that turn.
