# QMD Memory Plugin

HybridClaw ships an installable QMD memory plugin source at
[`plugins/qmd-memory`](../../plugins/qmd-memory).
The plugin complements the built-in SQLite session memory with external QMD
search over markdown notes, docs, and optional exported session transcripts.

## Install

1. Install QMD separately. The plugin shells out to the `qmd` CLI and does not
   embed QMD as a library.
2. Install the plugin from this repo:

   ```bash
   hybridclaw plugin install ./plugins/qmd-memory
   ```

3. Reload plugins in an active session:

   ```text
   /plugin reload
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
          "searchMode": "search",
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
- `workingDirectory`: directory used as the QMD process cwd. Defaults to the
  HybridClaw runtime cwd.
- `searchMode`: `search`, `vsearch`, or `query`. Defaults to `search`.
- `maxResults`: max QMD hits to format into prompt context.
- `maxSnippetChars`: per-result snippet/context cap before formatting.
- `maxInjectedChars`: total prompt context budget for injected QMD results.
- `timeoutMs`: per-QMD-process timeout.
- `sessionExport`: when `true`, rewrite the current session transcript as
  markdown after each turn.
- `sessionExportDir`: optional override for transcript exports. Defaults to
  `<workingDirectory>/.hybridclaw/qmd-sessions`.

## Behavior

- Before each turn, the plugin searches QMD with the latest user message and
  injects the top matching snippets into prompt context.
- On search failure or missing `qmd`, the plugin logs a warning and falls back
  to no extra context.
- When `sessionExport` is enabled, HybridClaw writes one markdown file per
  session so QMD can index past conversations as a normal collection.
- Diagnostics are available through the text command `qmd status`.
