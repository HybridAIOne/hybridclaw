---
title: Honcho Memory Plugin
description: Setup and behavior for the bundled `honcho-memory` plugin that syncs HybridClaw sessions into Honcho.
sidebar_position: 7
---

# Honcho Memory Plugin

HybridClaw ships a bundled Honcho plugin at
[`plugins/honcho-memory`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/honcho-memory).

The plugin does two things:

- mirrors completed HybridClaw user and assistant turns into a Honcho
  workspace/session
- injects Honcho session context, summaries, peer representation, and peer card
  back into later prompts

## Install

```bash
hybridclaw plugin install ./plugins/honcho-memory
hybridclaw plugin config honcho-memory baseUrl https://api.honcho.dev
hybridclaw plugin config honcho-memory workspaceId hybridclaw
```

For the managed API, also set an API key:

```text
/plugin config honcho-memory apiKey YOUR_HONCHO_API_KEY
```

For a self-hosted Honcho instance with auth disabled, `apiKey` can be omitted
and `baseUrl` can point at your local server, for example `http://localhost:8000`.

## Useful Config

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
          "contextTokens": 4000,
          "includeSummary": true,
          "includePeerRepresentation": true
        }
      }
    ]
  }
}
```

Key settings:

- `baseUrl`: Honcho API base URL
- `apiKey`: optional bearer token for authenticated deployments
- `workspaceId`: Honcho workspace to mirror HybridClaw sessions into
- `autoSync`: enable or disable turn mirroring
- `contextTokens`: token budget requested from Honcho's session context endpoint
- `includeSummary`, `includeRecentMessages`, `includePeerRepresentation`,
  `includePeerCard`: control which Honcho sections get injected

## Runtime Behavior

- startup: ensures the configured Honcho workspace exists
- turn completion: posts new user and assistant messages into the Honcho session
- prompt build: fetches Honcho session context using the latest user question as
  `search_query`
- command surface:
  - `/honcho status` shows queue status for the current mirrored session
  - `/honcho search <query>` searches the current Honcho session directly

The plugin keeps sync session-scoped by default (`limitToSession: true`) so
prompt injection stays focused on the active HybridClaw conversation.
