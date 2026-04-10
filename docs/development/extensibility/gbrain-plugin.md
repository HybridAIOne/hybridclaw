---
title: GBrain Plugin
description: Setup, configuration, and runtime behavior for the bundled `gbrain` plugin.
sidebar_position: 8
---

# GBrain Plugin

HybridClaw ships an installable GBrain integration at
[`plugins/gbrain`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/gbrain).

The plugin wraps the external
[GBrain CLI](https://github.com/garrytan/gbrain) and uses it in three ways:

- prompt-time recall: before each turn, HybridClaw can query GBrain with the
  latest user message and inject the top matching snippets into prompt context
- prefixed plugin tools: the plugin mirrors GBrain's operation catalog as
  `gbrain_*` tools such as `gbrain_query`, `gbrain_get_page`, and
  `gbrain_sync_brain`
- manual gateway command: `/gbrain status` shows health, configured mode, and
  brain stats, while `/gbrain ...` passes through raw CLI subcommands

HybridClaw built-in memory stays active when GBrain is enabled. GBrain is the
external world-knowledge layer; HybridClaw memory remains the place for local
session history, preferences, and operational notes.

## Install

1. Install GBrain separately and make the CLI available on `PATH`, or build a
   compiled binary and point the plugin at it.

   The upstream project currently documents:

   ```bash
   bun add github:garrytan/gbrain
   gbrain init --supabase
   ```

   If you prefer not to rely on the Bun shebang wrapper, point
   `plugins.list[].config.command` at the compiled `bin/gbrain` binary instead.

2. Install the bundled HybridClaw plugin source:

   ```bash
   hybridclaw plugin install ./plugins/gbrain
   ```

3. Reload plugins in an active local session:

   ```text
   /plugin reload
   ```

4. Optional: set credentials through `/secret` if you do not already keep them
   in `~/.gbrain/config.json` or your shell environment.

   ```text
   /secret set GBRAIN_DATABASE_URL postgres://...
   /secret set OPENAI_API_KEY sk-...
   /secret set ANTHROPIC_API_KEY sk-ant-...
   ```

   The plugin only forwards these declared keys into the GBrain child process:
   `GBRAIN_DATABASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`, and
   `ANTHROPIC_API_KEY`.

## Config

Pin plugin settings in `plugins.list[]` when you need non-default behavior:

```json
{
  "plugins": {
    "list": [
      {
        "id": "gbrain",
        "enabled": true,
        "config": {
          "command": "gbrain",
          "searchMode": "query",
          "maxResults": 5,
          "maxSnippetChars": 700,
          "maxInjectedChars": 5000,
          "timeoutMs": 12000
        }
      }
    ]
  }
}
```

Supported config keys:

- `command`: GBrain executable to spawn. Defaults to `gbrain`.
  This value is executed directly by the gateway process, so treat it as
  trusted operator configuration only.
- `workingDirectory`: child-process cwd for GBrain calls. Defaults to the
  HybridClaw runtime cwd.
- `searchMode`: `query` or `search`. Defaults to `query`.
- `maxResults`: max GBrain hits to format into prompt context.
- `maxSnippetChars`: per-result snippet cap before prompt formatting.
- `maxInjectedChars`: total character budget for injected GBrain context.
- `timeoutMs`: timeout for background retrieval and status probes. Explicit
  passthrough commands and plugin tools use a larger fixed timeout.

## Behavior

- Before each turn, the plugin inspects the latest user message and runs
  `gbrain query` by default. If that misses, it retries with a condensed
  keyword fallback through `gbrain search`.
- Retrieved GBrain hits are injected as their own retrieval section. They may
  reference pages outside the local workspace, so the model should answer from
  the snippets and slugs instead of treating the source page as missing.
- During plugin registration, HybridClaw calls `gbrain --tools-json` and
  registers the discovered operations as `gbrain_*` plugin tools. The prefix is
  intentional and avoids collisions with the global tool namespace.
- The plugin also injects a short prompt guide describing when to prefer
  `gbrain_query`, `gbrain_search`, and the relevant read/write follow-up tools.
- `/gbrain status` summarizes the configured command, retrieval mode, GBrain
  doctor checks, and brain stats.
- Any other `/gbrain ...` command is passed through to the GBrain CLI and runs
  with a longer timeout.

## How-To

### Confirm that retrieval is active

```text
/gbrain status
What changed with Acme since Tuesday?
```

Verification paths:

- the TUI footer shows `🪼 plugins: gbrain` when a reply used GBrain context
- `~/.hybridclaw/data/last_prompt.jsonl` contains
  `External gbrain knowledge results:` for that turn

### Force lexical fallback while debugging

```text
/plugin config gbrain searchMode search
/plugin reload
/gbrain status
```

This switches prompt-time retrieval to exact keyword search instead of the
hybrid `query` path.

### Use the mirrored tools explicitly

Typical read flow:

- `gbrain_query` for open-ended factual recall
- `gbrain_search` for exact names and terms
- `gbrain_get_page` for the full page after a hit
- `gbrain_get_backlinks` or `gbrain_get_timeline` for relationship and
  chronology follow-up

Typical write flow:

- `gbrain_put_page`
- `gbrain_add_link`
- `gbrain_add_timeline_entry`
- `gbrain_log_ingest`
- `gbrain_sync_brain`

## Tips & Tricks

- Prefer `query` for natural-language prompts. It is the default and lets
  GBrain combine vector search, keyword search, and multi-query expansion.
- Prefer `search` when you are debugging exact-name hits or page-path probes.
- If you install GBrain through the Bun wrapper, make sure `bun` is also on
  `PATH`. Otherwise point `command` at a compiled binary.
- If `/plugin list` shows `gbrain` as loaded but no `gbrain_*` tools appear,
  `gbrain --tools-json` likely failed during plugin registration. Check
  `/gbrain status` and the gateway logs first.
