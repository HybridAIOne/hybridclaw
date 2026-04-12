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

## Requirements

- a Mem0 API key from [app.mem0.ai](https://app.mem0.ai/dashboard/api-keys)
- local plugin install so the plugin-local `mem0ai` dependency is available

## Install

```bash
hybridclaw plugin install ./plugins/mem0-memory --yes
hybridclaw plugin enable mem0-memory
```

Then configure the API key:

```text
/secret set MEM0_API_KEY your-mem0-key
/plugin reload
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
- `appId`: defaults to `hybridclaw`
- `prefetchRerank`: rerank prompt-time Mem0 searches
- `syncTurns`: disable automatic turn mirroring when set to `false`
- `mirrorNativeMemoryWrites`: disable explicit native-memory mirroring when set
  to `false`

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

1. The plugin runs a Mem0 health check on startup.
2. Before prompts, it fetches a profile snapshot and searches Mem0 using the
   latest user message.
3. After each completed turn, it mirrors user and assistant messages into Mem0.
4. When HybridClaw writes native memory files such as `USER.md`, it mirrors the
   explicit write into Mem0 as a durable conclusion.

Read-side Mem0 recall is scoped to the current HybridClaw user id by default.
Write-side sync uses the current HybridClaw user id plus the active agent id so
Mem0 keeps attribution data.

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
