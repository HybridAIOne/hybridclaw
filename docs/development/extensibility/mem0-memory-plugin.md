---
title: Mem0 Memory Plugin
description: Setup and behavior for the bundled `mem0-memory` plugin.
sidebar_position: 3
---

# Mem0 Memory Plugin

HybridClaw ships a bundled Mem0 memory provider at
[`plugins/mem0-memory`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/mem0-memory).

The plugin keeps HybridClaw's built-in memory active and layers Mem0 cloud
recall on top. It can:

- inject prompt-time Mem0 profile and semantic-search context
- expose direct `mem0_profile`, `mem0_search`, and `mem0_conclude` tools
- expose a `/mem0 ...` command surface in local sessions
- mirror completed turns into Mem0 under the active HybridClaw user and agent
- mirror explicit native memory writes back into Mem0 as durable conclusions
- prefetch profile context on `session_start` to hide latency on the first turn
- curate a pre-compaction snapshot into Mem0 before older messages are archived
- clear per-session prefetch state on `session_end` and `session_reset`

## Requirements

- a Mem0 API key from [app.mem0.ai](https://app.mem0.ai/dashboard/api-keys)
- local plugin install so the plugin-local `mem0ai` dependency is available

## Install

```bash
hybridclaw plugin install ./plugins/mem0-memory --yes
```

`plugin install` already enables the plugin and reloads the runtime — no
separate `plugin enable` or `/plugin reload` is required.

Then configure the API key:

```text
/secret set MEM0_API_KEY your-mem0-key
```

## Minimal Config

```json
{
  "plugins": {
    "list": [
      {
        "id": "mem0-memory",
        "enabled": true,
        "config": {
          "host": "https://api.mem0.ai",
          "apiVersion": "v2",
          "searchLimit": 5,
          "profileLimit": 10
        }
      }
    ]
  }
}
```

Useful optional keys:

- `organizationId`: pin the plugin to a specific Mem0 organization
- `projectId`: pin the plugin to a specific Mem0 project
- `userId`: override HybridClaw's per-session user id
- `agentId`: override HybridClaw's active agent id
- `prefetchRerank`: rerank prompt-time Mem0 searches
- `readAgentScope`: expand read-side recall to the active agent scope as well as
  the active user scope
- `syncTurns`: disable automatic turn mirroring when set to `false`
- `mirrorNativeMemoryWrites`: disable explicit native-memory mirroring when set
  to `false`
- `prefetchOnSessionStart`: disable the `session_start` profile prefetch when
  set to `false`
- `syncCompaction`: disable pre-compaction curation when set to `false`

## Commands

The plugin registers `/mem0` with these subcommands:

- `/mem0 status`
- `/mem0 profile`
- `/mem0 search <query>`
- `/mem0 conclude <fact>`

Examples:

```text
/mem0 status
/mem0 profile
/mem0 search dark mode
/mem0 conclude User prefers short status updates.
```

## Tools

The plugin registers these tools:

- `mem0_profile`
- `mem0_search`
- `mem0_conclude`

Use `mem0_search` for targeted recall, `mem0_profile` for a broader snapshot,
and `mem0_conclude` only for durable facts or corrections worth keeping across
sessions.

## Runtime Behavior

When enabled with a configured `MEM0_API_KEY`:

1. The plugin runs a Mem0 health check on startup as a fire-and-forget
   background task, so gateway startup is not blocked by a slow Mem0 endpoint.
2. On `session_start`, the plugin prefetches a profile snapshot for the active
   HybridClaw user so the first prompt turn reuses the warm result.
3. Before prompts, it uses the prefetched profile when available and searches
   Mem0 using the latest user message.
4. After each completed turn, it mirrors user and assistant messages into Mem0.
5. On `before_compaction`, it curates the compaction summary and the oldest
   trimmed messages into Mem0 as a `hybridclaw-compaction` conclusion, so
   context that falls out of the window is still recoverable via Mem0 recall.
6. On `session_end` and `session_reset`, it drops the per-session prefetch
   state so the next session starts with a fresh profile fetch.
7. When HybridClaw writes native memory files such as `USER.md`, it mirrors the
   explicit write into Mem0 as a durable conclusion.

Read-side Mem0 recall is scoped to the current HybridClaw user id by default.
If `readAgentScope` is enabled, the plugin performs a dual-scope read across
the active user id or the active agent id. Write-side sync uses the current
HybridClaw user id plus the active agent id so Mem0 keeps attribution data.

## Peer Identity

Mem0 recall is user-scoped by default. If you enable `readAgentScope`, Mem0
uses a dual-scope OR query across the active user id and active agent id,
because Mem0 stores entity scopes separately. Unlike `honcho-memory`, the
plugin does not model separate user-peer and AI-peer representations. If you
need strict peer separation or intersection-style scoping, prefer
`honcho-memory`.

## Verification

1. Install and enable the plugin.
2. Set `MEM0_API_KEY`.
3. Run `/mem0 status` and confirm `Connection: ok`.
4. Chat for a turn, then run `/mem0 search <a fact from that turn>`.
5. Save an explicit native memory fact, then run `/mem0 search <that fact>`.

Expected result: prompt-time recall includes Mem0 context, `/mem0 search ...`
returns stored memories, and explicit native memory writes appear in later Mem0
search results.

## Tips & Tricks

- Leave `userId` and `agentId` unset unless you have a deliberate cross-session
  routing plan. The defaults follow HybridClaw's active user and agent scope.
- Leave `readAgentScope` disabled unless you intentionally want prompt-time
  recall to include memories addressable through the active agent id.
- Keep `apiVersion: v2` unless you have a concrete compatibility reason to use
  `v1`; the plugin is tuned around Mem0's newer filtered read path.
- Use `mem0_profile` first when you want a broad snapshot, and `mem0_search`
  for narrower questions. That keeps prompt and tool usage more predictable.
- Keep `syncTurns` enabled for normal operation, but temporarily disable it if
  you want read-only Mem0 recall during debugging or rollout.
- Keep `mirrorNativeMemoryWrites` enabled when you want explicit `USER.md` or
  `MEMORY.md` saves to become durable Mem0 facts without extra manual steps.

## Troubleshooting

- `/mem0 status` reports a missing API key:
  set `MEM0_API_KEY` through `/secret`, then reload the plugin. The plugin does
  not read plaintext API keys from plugin config.
- The plugin loads but prompt recall is empty:
  verify the scoped Mem0 user id, then run `/mem0 profile` and `/mem0 search`
  manually to determine whether the issue is missing stored memories or prompt
  injection.
- Search results look too broad or unrelated:
  confirm you are using the intended HybridClaw user scope, and override
  `userId` only when you intentionally want shared memory across sessions.
- New turns are not showing up in Mem0:
  check that `syncTurns` is still enabled and that `/mem0 status` reports a
  healthy connection before assuming retrieval is broken.
- Repo edits do not affect the installed plugin:
  run `/plugin reinstall ./plugins/mem0-memory` and then `/plugin reload`
  because reload alone uses the installed copy under `~/.hybridclaw/plugins/`.
