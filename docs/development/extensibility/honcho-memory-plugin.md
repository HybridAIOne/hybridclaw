---
title: Honcho Memory Plugin
description: Setup, configuration, commands, and runtime behavior for the bundled `honcho-memory` plugin.
sidebar_position: 7
---

# Honcho Memory Plugin

HybridClaw ships a bundled Honcho integration at
[`plugins/honcho-memory`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/honcho-memory).

The plugin mirrors HybridClaw conversations into Honcho and uses that mirrored
memory in three ways:

- prompt-time recall: prefetched Honcho summaries, peer representations, peer
  cards, recent messages, and dialectic guidance are injected into later turns
- agent tools: the model can call Honcho directly to inspect profiles, search
  memory, ask contextual questions, or save explicit conclusions
- native user-profile sync: successful built-in `memory` writes to `USER.md`
  are promoted into Honcho conclusions instead of synthetic mirrored chat turns

It also keeps durable plugin-local sync state so repeated gateway restarts do
not re-post the same session turns.

HybridClaw built-in memory stays active when Honcho is enabled. Honcho is an
additional external memory provider, not a replacement for `MEMORY.md`,
`USER.md`, or the normal session store.

Only one plugin marked as an external `memoryProvider` can be active at a time.
That keeps HybridClaw on a clear model: built-in memory plus at most one
external provider.

## What It Mirrors

Honcho receives:

- user and assistant turns from HybridClaw sessions
- optional identity and memory seed files from the agent workspace
- explicit saved conclusions created through the `honcho_conclude` tool

If you enable Honcho after a HybridClaw session already has stored turns, the
plugin backfills that earlier local user and assistant history once before
continuing normal turn sync.

By default the plugin seeds these files once per Honcho session when they exist
in the agent workspace:

- `SOUL.md`
- `IDENTITY.md`
- `AGENTS.md`
- `USER.md`
- `MEMORY.md`

This gives Honcho a migration path from an existing workspace instead of
starting from an empty memory graph.

## Install

For a local checkout:

```bash
hybridclaw plugin install ./plugins/honcho-memory
```

Then set the Honcho credential through `/secret`. The plugin can run on its
built-in defaults without any extra config:

```text
/secret set HONCHO_API_KEY your-honcho-key
```

If you want to pin explicit settings in `config.json`, a small stable config
looks like this:

```json
{
  "plugins": {
    "list": [
      {
        "id": "honcho-memory",
        "enabled": true,
        "config": {
          "baseUrl": "https://api.honcho.dev",
          "workspaceId": "hybridclaw",
          "sessionStrategy": "per-session",
          "recallMode": "hybrid",
          "writeFrequency": "async"
        }
      }
    ]
  }
}
```

The plugin reads `HONCHO_API_KEY` from `/secret` first-class through
`api.getCredential(...)`. A process environment variable with the same name also
works, but `/secret` is the preferred operator path.

For a self-hosted Honcho instance with auth disabled, point `baseUrl` at your
server and omit `apiKey`.

## Actual Defaults

These are the real runtime defaults when you install the plugin and only set the
secret:

- `baseUrl`: `https://api.honcho.dev`
- `workspaceId`: the current working directory name, normalized for Honcho
- `sessionStrategy`: `platform`
- `recallMode`: `hybrid`
- `writeFrequency`: `async`
- `limitToSession`: `true`

In this repository, running TUI from the repo root means the default
`workspaceId` becomes `hybridclaw`.

With the default `platform` session strategy, each new HybridClaw session
creates a new Honcho session under the same Honcho workspace and peers. Today,
`platform` and `per-session` resolve to the same Honcho session key behavior;
`per-session` is just the explicit version in config.

## Quick Start

This is the fastest way to get useful Honcho behavior in TUI without tuning
anything else first.

1. Start TUI from the workspace you want Honcho to learn about.

   ```bash
   hybridclaw tui
   ```

2. Inside TUI, set the secret and enable the bundled plugin.

   ```text
   /secret set HONCHO_API_KEY your-honcho-key
   /plugin enable honcho-memory
   /plugin list
   /honcho setup
   /honcho status
   ```

   If you are testing from a local checkout and want to refresh the local plugin
   files, use `/plugin reinstall ./plugins/honcho-memory --yes` instead of
   `/plugin enable honcho-memory`.

3. Give the session a few turns of real information.

   ```text
   My name is Ben.
   I prefer concise answers.
   I mainly work in TypeScript.
   I compare local implementations before changing runtime behavior.
   ```

4. Verify that Honcho can recall what it saw.

   ```text
   What do you know about me so far?
   /honcho search concise
   /honcho search TypeScript
   /honcho identity --show
   ```

Expected result:

- the normal assistant reply should mention the facts from the current session
- `/honcho search ...` should find mirrored session content
- `/honcho identity --show` should show the current user and AI peer state

## TUI Examples

Use these when you want to test specific behavior rather than just confirm basic
connectivity.

### Tools-Only Recall

This verifies that Honcho tool calls work even when prompt injection is off.

```text
/plugin config honcho-memory recallMode tools
/show tools
Summarize what Honcho knows about me using Honcho tools.
```

Expected result: the model should rely on `honcho_profile`, `honcho_search`, or
`honcho_context` instead of prompt-injected Honcho memory.

### Deterministic Turn Sync

This makes Honcho writes easier to observe while testing.

```text
/plugin config honcho-memory writeFrequency turn
Remember zebra-lantern-42.
/honcho search zebra-lantern-42
```

Expected result: the search result should include the latest turn immediately,
because the flush happens synchronously at the end of the turn.

### Buffered Session Sync

This shows the difference between `turn` and `session` write behavior.

```text
/plugin config honcho-memory writeFrequency session
Remember glacier-paperclip-19.
/honcho search glacier-paperclip-19
/honcho sync
/honcho search glacier-paperclip-19
```

Expected result: the first search may miss the latest turn, while the second
search should find it after `/honcho sync` flushes buffered messages.

### Shared Honcho Thread Across Sessions

This is useful when you want one durable Honcho thread instead of one thread per
HybridClaw session.

```text
/plugin config honcho-memory sessionStrategy global
/honcho status
```

Expected result: new HybridClaw sessions continue writing into the same Honcho
session for the current workspace.

## Recommended Starting Config

This is a good explicit starting config for regular use. It is not a verbatim
dump of literal defaults; it makes the important values visible and stable
across environments without making prompt recall too noisy:

```json
{
  "plugins": {
    "list": [
      {
        "id": "honcho-memory",
        "enabled": true,
        "config": {
          "baseUrl": "https://api.honcho.dev",
          "workspaceId": "hybridclaw",
          "sessionStrategy": "per-session",
          "recallMode": "hybrid",
          "writeFrequency": "async",
          "contextTokens": 4000,
          "searchLimit": 5,
          "dialecticReasoningLevel": "low",
          "dialecticDynamic": true,
          "limitToSession": true,
          "includeSummary": true,
          "includeRecentMessages": true,
          "includePeerRepresentation": true,
          "includePeerCard": true,
          "includeAiPeerRepresentation": true,
          "includeAiPeerCard": false
        }
      }
    ]
  }
}
```

## Session Mapping

Honcho session IDs do not have to match HybridClaw session IDs exactly.

`sessionStrategy` controls how HybridClaw picks a Honcho session key:

- `platform`: use the current HybridClaw session ID
- `per-session`: same as platform, but explicit in config
- `per-directory`: use the current agent workspace directory name
- `per-repo`: use the current git repository root name when one exists
- `global`: use the configured Honcho `workspaceId`

With the default `platform` strategy, a new HybridClaw session creates a new
Honcho session. If you want continuity across many HybridClaw sessions, switch
to `global`, `per-repo`, `per-directory`, or set a manual mapping.

You can override this per workspace with:

```text
/honcho map <name>
```

To remove a manual mapping:

```text
/honcho map --clear
```

## Recall Modes

The plugin separates built-in memory from Honcho recall.

HybridClaw built-in memory always remains on. When Honcho is enabled, user and
assistant turns are mirrored into Honcho unless `saveMessages: false` disables
turn mirroring entirely.

`recallMode` decides how the model can consume Honcho:

- `hybrid`: inject prompt context and register Honcho tools
- `context`: inject prompt context only
- `tools`: register Honcho tools only

Changing `recallMode` changes tool visibility. Reload plugins or restart the
gateway after switching between `context` and the tool-enabled modes.

## Write Behavior

`writeFrequency` controls when turns are sent to Honcho:

- `async`: enqueue background writes after each turn
- `turn`: write synchronously at the end of each turn
- `session`: buffer until the session ends
- positive integer: flush every `N` turns

`saveMessages: false` disables turn mirroring while keeping the command and
tool surface available.

Successful native `memory` writes that target `USER.md` are converted into
Honcho conclusions immediately. Daily-note writes stay in the normal transcript
sync path instead of being mirrored as synthetic Honcho messages.

## Prompt Recall

The plugin prefetches Honcho recall in the background and caches it for later
prompt construction. If that background prefetch is not ready yet, the first
prompt build still fetches and bakes a Honcho context block synchronously so the
session does not miss first-turn recall. Prompt sections can include:

- summary
- user representation
- user peer card
- AI self-representation
- AI peer card
- recent mirrored messages
- dialectic guidance from Honcho chat

Key prompt-recall settings:

- `contextTokens`: token budget requested from Honcho context
- `maxInjectedChars`: hard cap on injected prompt text
- `contextCadence`: refresh context every `N` turns
- `dialecticCadence`: refresh dialectic guidance every `N` turns
- `injectionFrequency`: inject every turn or only the first turn
- `limitToSession`: keep context limited to the active Honcho session

## Observation And Peer Identity

Each Honcho session includes a user peer and an AI peer. These can be tuned
with:

- `peerName`: optional user-facing label for the user peer
- `aiPeer`: override the derived AI peer name
- `sessionPeerPrefix`: prefix Honcho session keys with the peer name
- `observationMode`: `directional` or `unified`
- `observation.user.observeMe`
- `observation.user.observeOthers`
- `observation.ai.observeMe`
- `observation.ai.observeOthers`

Use these when you want to model a distinct assistant identity in Honcho rather
than treating the assistant as an anonymous writer.

## Dialectic Reasoning

Honcho chat is used for dialectic guidance and for the `honcho_context` tool.

Relevant settings:

- `dialecticReasoningLevel`: base reasoning floor
- `dialecticDynamic`: raise reasoning automatically for larger questions
- `reasoningLevelCap`: maximum reasoning level the plugin can request
- `dialecticMaxInputChars`: cap the question sent to Honcho chat
- `dialecticMaxChars`: cap the answer stored in prompt context

## Slash Commands

The plugin registers `/honcho` with these subcommands:

- `/honcho status`
- `/honcho search <query>`
- `/honcho sessions`
- `/honcho map <name>`
- `/honcho map --clear`
- `/honcho mode <hybrid|context|tools>`
- `/honcho recall <hybrid|context|tools>`
- `/honcho peer [--user <name>] [--ai <name>] [--reasoning <level>]`
- `/honcho tokens [--context <n>] [--dialectic <n>] [--input <n>]`
- `/honcho identity --show`
- `/honcho identity <path>`
- `/honcho setup`
- `/honcho sync`

Useful examples:

```text
/honcho status
/honcho search integration notes
/honcho map release-planning
/honcho mode tools
/honcho recall tools
/honcho peer --ai hybridclaw --reasoning medium
/honcho tokens --context 6000 --dialectic 900
/honcho identity --show
/honcho sync
```

## Agent Tools

When `recallMode` is not `context`, the model can call:

- `honcho_profile`
- `honcho_search`
- `honcho_context`
- `honcho_conclude`

Tool behavior:

- `honcho_profile`: fetch the current Honcho representation and peer card for
  the user or AI peer
- `honcho_search`: combine Honcho representation output with direct session
  message search
- `honcho_context`: ask Honcho a natural-language question using Honcho chat
- `honcho_conclude`: save an explicit conclusion about the current user

`honcho_profile`, `honcho_search`, and `honcho_context` accept `peer: user|ai`.

## Setup Workflow

The usual first-run flow is:

1. Install and enable the plugin.
2. Set `HONCHO_API_KEY` through `/secret`, then override `baseUrl`,
   `workspaceId`, or other plugin config only when you want non-default
   behavior.
3. Run `/honcho setup` in a session.
4. Run `/honcho status` to confirm connectivity.
5. Run `/honcho identity --show` to inspect the current user and AI peer
   representations.
6. Let the session run long enough for mirrored turns and prefetch to build up.

If you already have useful context in `SOUL.md`, `IDENTITY.md`, `USER.md`, or
`MEMORY.md`, the setup step will seed that data into Honcho on demand.

## Tips And Tricks

- Use the defaults first. In most cases, `/secret set HONCHO_API_KEY ...` plus
  `/honcho setup` is enough to get started.
- Keep `writeFrequency: async` for normal use when you care more about latency
  than immediate search visibility.
- Switch to `writeFrequency: turn` when you are debugging or demoing Honcho and
  want every turn to be searchable immediately.
- Keep `sessionStrategy: platform` or `per-session` when you want isolated
  memory threads for each chat session.
- Use `sessionStrategy: global` or `/honcho map <name>` when you want long-lived
  continuity across many sessions.
- Give test workspaces their own `workspaceId` so experiments do not mix with
  real memory.
- Use `/honcho identity --show` when the model's recall feels off. It is the
  quickest way to inspect what Honcho currently thinks about the user and AI
  peer.
- Use `/honcho sync` after a burst of conversation if you want to force a flush
  and refresh prompt context immediately.

## Troubleshooting

- No prompt recall appears:
  Check `recallMode`, `limitToSession`, and whether the Honcho workspace/session
  contains any mirrored turns yet.
- Tools are missing:
  `recallMode: context` disables tool registration. Reload the plugin or restart
  the gateway after changing it.
- Honcho will not load:
  Check whether another plugin is already marked as `memoryProvider: true`.
  HybridClaw allows built-in memory plus one external provider.
- The wrong sessions are grouped together:
  Change `sessionStrategy` or use `/honcho map <name>`.
- Honcho is receiving too much text:
  Lower `messageMaxChars`, `contextTokens`, or `dialecticMaxInputChars`.
- Honcho is too slow for your use case:
  Use `writeFrequency: async`, lower the cadence settings, or reduce the
  dialectic budgets.
