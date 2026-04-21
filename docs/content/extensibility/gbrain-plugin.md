---
title: GBrain Plugin
description: Recommended HybridClaw setup, configuration, and operator runbook for the bundled `gbrain` plugin.
sidebar_position: 8
---

# GBrain Plugin

HybridClaw ships a bundled GBrain integration at
[`plugins/gbrain`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/gbrain).

This is the recommended setup when you want HybridClaw to consult a separate
GBrain knowledge base before answering normal chat turns, while still keeping
HybridClaw's built-in memory active for local preferences, operational notes,
and session context.

The plugin wraps the external [GBrain CLI](https://github.com/garrytan/gbrain)
and uses it in three ways:

- prompt-time recall: before each turn, HybridClaw can run `gbrain query` or
  `gbrain search` against the latest user message and inject the top matching
  snippets into prompt context
- prefixed plugin tools: during registration, the plugin mirrors the installed
  GBrain operation catalog as `gbrain_*` tools such as `gbrain_query`,
  `gbrain_get_page`, and `gbrain_sync_brain`
- manual gateway command: `/gbrain status` shows health, configured mode, and
  brain stats, while `/gbrain ...` passes through raw CLI subcommands from the
  gateway

HybridClaw built-in memory stays active when GBrain is enabled. The clean model
is:

| Layer | What it stores | How HybridClaw uses it |
| --- | --- | --- |
| GBrain | durable world knowledge: people, companies, meetings, concepts, notes, originals | automatic recall, `gbrain_*` tools, optional MCP |
| HybridClaw built-in memory | preferences, operator instructions, local working context | normal HybridClaw memory layers and `memory` writes |
| Session transcript | the current conversation | automatic session context |

## What HybridClaw Implements

The plugin deliberately does not try to own the whole GBrain lifecycle.

- It does run prompt-time retrieval and register `gbrain_*` tools from
  `gbrain --tools-json`.
- It does expose `/gbrain status` plus generic `/gbrain ...` passthrough.
- It does forward only the declared GBrain credentials into the child process:
  `GBRAIN_DATABASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`, and
  `ANTHROPIC_API_KEY`.
- It does not install Bun or GBrain for you.
- It does not create your brain repo structure for you.
- It does not load the upstream GBrain skillpack into HybridClaw automatically.
- It does not schedule `gbrain sync`, `gbrain embed --stale`, or
  `gbrain check-update` for you.
- It does not auto-register the upstream GBrain MCP server.

That split is intentional. The plugin handles HybridClaw runtime integration;
you still operate GBrain itself as its own system.

## Recommended Architecture

Recommended day-one topology:

```text
HybridClaw session/work repo
        |
        | plugin config.workingDirectory
        v
separate markdown brain repo (git source of truth)
        |
        v
GBrain CLI + local PGLite or Supabase index
```

Use a dedicated brain repo such as `~/brain`, or reuse your main markdown vault
if that already is your source of truth. The important invariant is that the
plugin's `workingDirectory` points at the same repo GBrain is indexing and
syncing.

Upstream GBrain currently recommends starting locally with `gbrain init`
against embedded PGLite, then migrating to Supabase later if the brain outgrows
local scale. That fits HybridClaw well because the plugin only cares that the
`gbrain` command is healthy and can answer queries.

## Before You Activate It

You need a usable GBrain installation and a real markdown brain repo first.
HybridClaw is not the place to bootstrap that from scratch blindly.

If you are starting fresh, a minimal brain repo can look like this:

```text
~/brain/
  RESOLVER.md
  schema.md
  people/
  companies/
  meetings/
  concepts/
  originals/
```

For the actual directory model and operating rules, follow the upstream GBrain
docs:

- [GBRAIN_RECOMMENDED_SCHEMA.md](https://github.com/garrytan/gbrain/blob/master/docs/GBRAIN_RECOMMENDED_SCHEMA.md)
- [GBRAIN_SKILLPACK.md](https://github.com/garrytan/gbrain/blob/master/docs/GBRAIN_SKILLPACK.md)

The plugin works without those documents being loaded into the prompt, but the
agent will behave much better if you adopt the same brain-first discipline in
your local instructions or project skills.

## Install GBrain

For HybridClaw, the simplest path is a global `gbrain` command on `PATH`:

```bash
curl -fsSL https://bun.sh/install | bash
bun add -g github:garrytan/gbrain
gbrain --version
```

If you prefer a project-local install or a compiled binary, that also works.
In that case, point the plugin `command` config at the real executable path
instead of relying on `PATH`.

If you install through the Bun wrapper, `bun` must also be on `PATH` for the
gateway process, not just your interactive shell.

## Initialize The Brain

The current upstream recommendation is:

- start with `gbrain init`
- use local PGLite first
- move to Supabase later with `gbrain migrate --to supabase` if needed

Recommended local-first path:

```bash
cd ~/brain
gbrain init
gbrain doctor --json
```

If you already know the brain will be large or shared remotely, initialize
against Supabase directly:

```bash
cd ~/brain
gbrain init --supabase
gbrain doctor --json
```

Important for Supabase:

- use the Session mode pooler or direct connection string
- do not use Transaction mode pooler strings for sync workloads

If sync later reports success but your indexed page count is far too low, wrong
pooler mode is the first thing to check.

## Import Content And Prove Search Works

Before enabling the plugin, make sure GBrain itself can answer at least one real
query against your data.

Example discovery pass:

```bash
find ~/git ~/Documents ~/notes -maxdepth 3 -name "*.md" | head -30
```

Then import the repo or vault you want GBrain to index:

```bash
gbrain import ~/brain --no-embed
gbrain stats
gbrain embed --stale
gbrain query "what are the key themes across these documents?"
```

If `~/brain` is a brand-new empty repo, populate it first or import an existing
markdown repo instead.

Expected result:

- `gbrain stats` shows non-zero pages
- `gbrain embed --stale` completes without provider errors
- `gbrain query ...` returns meaningful hits instead of an empty result set

Do not enable the HybridClaw plugin until this base path is healthy. Otherwise
you are debugging two systems at once.

## Activate The Plugin

### From the CLI

Install the bundled plugin from this repository checkout:

```bash
hybridclaw plugin install ./plugins/gbrain
hybridclaw plugin config gbrain workingDirectory ~/brain
hybridclaw plugin config gbrain searchMode query
hybridclaw plugin check gbrain
```

If you are iterating on the plugin from a local checkout, use `reinstall`
instead of `install` when you want the home-installed copy refreshed:

```bash
hybridclaw plugin reinstall ./plugins/gbrain
hybridclaw plugin check gbrain
```

### From a local TUI or web session

`/plugin install`, `/plugin reinstall`, and `/plugin check` are available from
local TUI or web sessions.

```text
/plugin install ./plugins/gbrain
/plugin enable gbrain
/plugin config gbrain workingDirectory ~/brain
/gbrain status
```

Both `/plugin install` and `/plugin enable` automatically reload the plugin
runtime — no separate `/plugin reload` is needed.

If you are updating the plugin from a local checkout:

```text
/plugin reinstall ./plugins/gbrain
/plugin check gbrain
```

### Credentials

If your GBrain install already works from `~/.gbrain/config.json` or the
gateway process environment, you may not need to set anything else.

If you want HybridClaw to inject credentials explicitly into the GBrain child
process, set them through `/secret`:

```text
/secret set GBRAIN_DATABASE_URL postgres://...
/secret set OPENAI_API_KEY sk-...
/secret set ANTHROPIC_API_KEY sk-ant-...
```

Supported credential names:

- `GBRAIN_DATABASE_URL`
- `DATABASE_URL`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Recommendation: prefer `/secret` or an existing GBrain config file over
hardcoding credentials in tracked config.

## Recommended Starting Config

This is a good explicit starting config for HybridClaw:

```json
{
  "plugins": {
    "list": [
      {
        "id": "gbrain",
        "enabled": true,
        "config": {
          "command": "gbrain",
          "workingDirectory": "~/brain",
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

Why these settings:

- `workingDirectory` is the most important explicit setting. Point it at the
  brain repo, not whatever project directory you happen to open in TUI.
- `query` is the best starting search mode because it lets GBrain combine
  semantic and keyword retrieval.
- the default result and snippet budgets are large enough to be useful without
  flooding prompt context
- `timeoutMs` is conservative for local or healthy remote setups; increase it
  if your GBrain backend is remote and cold-start latency is visible

Supported config keys:

- `command`: GBrain executable to spawn. Defaults to `gbrain`.
  This path is executed directly by the gateway process, so treat it as trusted
  operator configuration only.
- `workingDirectory`: child-process cwd for GBrain calls. Recommended to point
  explicitly at your brain repo.
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

## Recommended HybridClaw Rules

The plugin's short built-in prompt hook is intentionally minimal. If you want a
HybridClaw session to behave like a real GBrain-backed agent, add rules like
these to your project instructions, workspace docs, or a local skill:

- Before answering questions about people, companies, meetings, concepts, or
  prior notes, check GBrain first.
- Use `gbrain_query` for open-ended retrieval and `gbrain_search` for exact
  names, terms, or slug probes.
- After a promising hit, use `gbrain_get_page` or another targeted read tool
  before making strong claims.
- When the user provides durable new facts, write them back with the relevant
  `gbrain_*` write tools instead of leaving them only in chat history.
- After external markdown repo edits, run `gbrain_sync_brain` or
  `/gbrain sync --repo <path>` so retrieval stays current.
- Keep operator preferences and session-local instructions in HybridClaw
  built-in memory, not in GBrain.

Those rules are the HybridClaw equivalent of the upstream brain-first loop.

## TUI Examples

### Confirm that retrieval is active

```text
/gbrain status
What changed with Acme since Tuesday?
```

Verification paths:

- the TUI footer shows `🪼 plugins: gbrain` when a reply used GBrain context
- `~/.hybridclaw/data/last_prompt.jsonl` contains
  `External gbrain knowledge results:` for that turn
- `/gbrain status` reports doctor and stats output without child-process errors

### Force lexical fallback while debugging

```text
/plugin config gbrain searchMode search
/plugin reload
/gbrain status
```

This switches prompt-time retrieval to exact keyword search instead of the
hybrid `query` path.

### Use the command passthrough directly

The slash command is a raw CLI passthrough after the special `status` case:

```text
/gbrain query "what do we know about competitive dynamics?"
/gbrain search "Pedro Franceschi"
/gbrain call get_stats {}
```

Use this when you want the exact CLI output rather than waiting for the model to
decide whether to call a plugin tool.

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

Typical prompt to the model:

```text
Use GBrain to find the Acme company page, read the full page, then summarize the current state and open threads with citations to the brain page slug.
```

### Keep the brain current after manual edits

If you edit the markdown repo outside the tool surface, sync it explicitly:

```text
/gbrain sync --repo ~/brain
/gbrain embed --stale
```

If your repo is large, run those from the shell or a scheduled job instead of
manually after every change.

## Optional: Add The GBrain MCP Server

The plugin and the upstream GBrain MCP server solve different problems:

- the plugin gives HybridClaw automatic prompt-time recall, `/gbrain` command
  access, and `gbrain_*` plugin tools
- the MCP server gives HybridClaw the upstream native stdio tool surface from
  `gbrain serve`

Start with the plugin only. Add MCP later if you specifically want the upstream
MCP server available inside HybridClaw too.

Important tradeoff:

- with both enabled, the model will usually see both `gbrain_*` plugin tools
  and `gbrain__*` MCP tools
- that is valid, but it increases tool duplication and choice ambiguity

If you want the MCP server, add it separately. For stdio MCP servers that
depend on host binaries, start the gateway in host sandbox mode first. See
[TUI MCP Quickstart](../guides/tui-mcp.md).

### Local TUI or web session

Minimal server registration:

```text
/mcp add gbrain {"transport":"stdio","command":"gbrain","args":["serve"],"enabled":true}
/mcp list
```

This assumes the spawned `gbrain` process can already resolve its own database
and provider config from the host environment or its existing GBrain config
files.

Expected result:

- `/mcp list` shows an enabled `gbrain` stdio server
- the model can use namespaced tools such as `gbrain__query` and
  `gbrain__get_page`
- the plugin continues handling automatic prompt recall independently

### Config file alternative

You can also add the same server directly under `mcpServers` in
`~/.hybridclaw/config.json`:

```json
{
  "mcpServers": {
    "gbrain": {
      "transport": "stdio",
      "command": "gbrain",
      "args": ["serve"],
      "enabled": true
    }
  }
}
```

If your GBrain install depends on environment variables instead of persisted
GBrain config, add the required `env` keys there or launch the gateway with
those values present.

## Live Sync And Operations

The plugin does not keep the GBrain index current by itself. You still need a
sync path for the markdown repo.

Recommended operational jobs:

| Task | Command | Cadence |
| --- | --- | --- |
| sync + embed | `gbrain sync --repo ~/brain && gbrain embed --stale` | every 5-30 minutes |
| update check | `gbrain check-update --json` | daily |
| health check | `gbrain doctor --json` | after config changes and periodically |

The upstream GBrain recommendation is to always chain sync and embed:

```bash
gbrain sync --repo ~/brain && gbrain embed --stale
```

For near-real-time indexing, you can run a watcher too:

```bash
gbrain sync --watch --repo ~/brain
```

Treat `--watch` as a foreground process that may exit after repeated failures.
Run it under a process manager or keep a cron fallback.

Recommended operator stance:

- cron is the safest starting point
- `--watch` is an optimization, not your only sync path
- if you use Supabase, verify Session mode pooler before trusting sync

For the upstream sync runbook, see
[Live Sync](https://github.com/garrytan/gbrain/blob/master/docs/guides/live-sync.md).

## Local TUI Verification Protocol

1. Confirm the binary and plugin health:

   ```text
   /plugin check gbrain
   /gbrain status
   ```

   Expected: the plugin is loaded, the configured command resolves, and doctor
   plus stats output render without fatal errors.

2. Confirm prompt-time retrieval:

   ```text
   What do we know about a person or topic that definitely exists in the brain?
   ```

   Expected: the footer shows `🪼 plugins: gbrain` and
   `last_prompt.jsonl` contains `External gbrain knowledge results:`.

3. Confirm direct CLI access:

   ```text
   /gbrain query "known phrase from the brain"
   /gbrain search "known exact term"
   ```

   Expected: both commands return real hits without shell errors.

4. Confirm end-to-end sync:

   ```bash
   gbrain stats
   find ~/brain -name '*.md' \
     -not -path '*/.*' \
     -not -path '*/.raw/*' \
     -not -path '*/ops/*' \
     -not -name 'README.md' \
     -not -name 'index.md' \
     -not -name 'schema.md' \
     -not -name 'log.md' \
     | wc -l
   ```

   Expected: page count in `gbrain stats` is reasonably close to the syncable
   markdown count.

5. Edit a brain page, run sync, then search for the updated text.

   Expected: the search returns the new text, not stale content.

For the upstream verification runbook, see
[GBRAIN_VERIFY.md](https://github.com/garrytan/gbrain/blob/master/docs/GBRAIN_VERIFY.md).

## Example Prompts and Use Cases

### Recall knowledge about people or companies

```text
What do we know about Pedro Franceschi and his company?
```

The plugin queries GBrain before the turn and injects matching brain pages into
prompt context. The model answers using both session history and GBrain recall.

### Store durable facts back to the brain

```text
Use gbrain_put_page to save a new page about the partnership discussion
with Acme Corp. Include the key terms we agreed on.
```

This writes directly to the GBrain knowledge base so the information is
available in future sessions and across projects.

### Research and follow-up

```text
Use GBrain to find the Acme company page, read the full page, then
summarize the current state and open threads with citations.
```

This triggers a read flow: `gbrain_query` to find the page, then
`gbrain_get_page` for the full content.

### Track chronological events

```text
Use gbrain_add_timeline_entry to log that we signed the contract with
Acme on 2026-04-15.
```

GBrain's timeline features let you track events and retrieve them
chronologically.

### Keep the brain current after external edits

```text
/gbrain sync --repo ~/brain
/gbrain embed --stale
```

Run these after editing brain markdown files outside HybridClaw.

## Tips & Tricks

- Prefer `query` for natural-language prompts. It is the default and lets
  GBrain combine vector search, keyword search, and multi-query expansion.
- Prefer `search` when you are debugging exact-name hits or page-path probes.
- On a fresh local setup, initialize GBrain before testing the plugin:

  ```bash
  mkdir -p ~/.gbrain
  gbrain init
  ```

  This creates the local PGLite brain at `~/.gbrain/brain.pglite`. That path is
  the local GBrain database, not the markdown brain repo. Keep plugin
  `workingDirectory` pointed at the repo you actually import and sync.
- Set `workingDirectory` explicitly. It is the single most common source of
  "loaded plugin, wrong brain" confusion.
- If you install GBrain through the Bun wrapper, make sure `bun` is also on
  `PATH`. Otherwise point `command` at a compiled binary or real wrapper path.
- If `/plugin list` shows `gbrain` as loaded but no `gbrain_*` tools appear,
  `gbrain --tools-json` likely failed during plugin registration. Check
  `/gbrain status` and the gateway logs first.
- If `gbrain query` returns weak or purely lexical results, run
  `gbrain embed --stale` and verify `OPENAI_API_KEY` is available.
- If sync seems to run but results stay stale on Supabase, check for a
  Transaction mode pooler URL and switch to Session mode.

## Troubleshooting

- **Plugin loads but no `gbrain_*` tools appear:**
  `gbrain --tools-json` likely failed during plugin registration. Check
  `/gbrain status` and the gateway logs. Verify that `gbrain --version`
  works from the shell the gateway process uses.

- **No prompt recall appears:**
  GBrain returned no matches. Check that the brain has indexed pages with
  `gbrain stats` and that embeddings are built with `gbrain embed --stale`.

- **Wrong brain is being queried:**
  Set `workingDirectory` explicitly to your brain repo path. This is the
  single most common source of "loaded plugin, wrong brain" confusion.

- **Bun not found by gateway:**
  If you installed GBrain through the Bun wrapper, `bun` must be on `PATH`
  for the gateway process, not just your interactive shell. Alternatively,
  point `command` at a compiled binary.

- **Supabase sync shows success but page count is low:**
  Check for a Transaction mode pooler URL in your connection string. GBrain
  sync requires Session mode pooler or a direct connection string.

- **Weak or purely lexical results from `gbrain query`:**
  Embeddings may be missing or stale. Run `gbrain embed --stale` and verify
  that `OPENAI_API_KEY` is available for the embedding model.

- **Credential errors:**
  Use `/secret set` for credentials rather than hardcoding in config. The
  plugin reads `GBRAIN_DATABASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`, and
  `ANTHROPIC_API_KEY` from HybridClaw secrets and injects them into the child
  process.
