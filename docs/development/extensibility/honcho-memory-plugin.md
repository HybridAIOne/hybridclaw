---
title: Honcho Memory Plugin
description: Setup, configuration, commands, and runtime behavior for the bundled `honcho-memory` plugin.
sidebar_position: 7
---

# Honcho Memory Plugin

HybridClaw ships a bundled Honcho integration at
[`plugins/honcho-memory`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/honcho-memory).

The plugin mirrors HybridClaw conversations into Honcho and uses that mirrored
memory in two ways:

- prompt-time recall: prefetched Honcho summaries, peer representations, peer
  cards, recent messages, and dialectic guidance are injected into later turns
- agent tools: the model can call Honcho directly to inspect profiles, search
  memory, ask contextual questions, or save explicit conclusions

It also keeps durable plugin-local sync state so repeated gateway restarts do
not re-post the same session turns.

HybridClaw built-in memory stays active when Honcho is enabled. Honcho is an
additional external memory provider, not a replacement for `MEMORY.md`,
`USER.md`, or the normal session store.

Only one plugin marked as an external `memoryProvider` can be active at a time.
That keeps Honcho aligned with the Hermes Agent model: built-in memory plus at
most one external provider.

## What It Mirrors

Honcho receives:

- user and assistant turns from HybridClaw sessions
- optional identity and memory seed files from the agent workspace
- explicit saved conclusions created through the `honcho_conclude` tool

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

Then configure the plugin in either `config.json` or through the plugin config
commands. The smallest managed Honcho setup looks like this:

```json
{
  "plugins": {
    "list": [
      {
        "id": "honcho-memory",
        "enabled": true,
        "config": {
          "baseUrl": "https://api.honcho.dev",
          "apiKey": "honcho-key",
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

You can also provide the API key through the process environment before starting
HybridClaw:

```bash
export HONCHO_API_KEY=honcho-key
hybridclaw gateway
```

For a self-hosted Honcho instance with auth disabled, point `baseUrl` at your
server and omit `apiKey`.

## Recommended Starting Config

This configuration matches the full HybridClaw feature set without making
prompt recall too noisy:

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

## Prompt Recall

The plugin prefetches Honcho recall in the background and caches it for later
prompt construction. Prompt sections can include:

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
2. Configure `baseUrl`, `workspaceId`, and optionally `apiKey`.
3. Run `/honcho setup` in a session.
4. Run `/honcho status` to confirm connectivity.
5. Run `/honcho identity --show` to inspect the current user and AI peer
   representations.
6. Let the session run long enough for mirrored turns and prefetch to build up.

If you already have useful context in `SOUL.md`, `IDENTITY.md`, `USER.md`, or
`MEMORY.md`, the setup step will seed that data into Honcho on demand.

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
