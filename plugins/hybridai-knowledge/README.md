# HybridAI Knowledge

Grounds every agent turn in the HybridAI knowledge collections, and keeps the
company wiki tidy with a nightly maintenance turn.

Before each turn the plugin sends the latest user message to the platform's
`knowledge_search` and injects the best sections as retrieved context, each
tagged `[knowledge: <collection>/<path>#anchor]`. The platform decides what
the API key's owner may read: company collections by role, plus that owner's
shared bot document collections. This is key-wide access, not per-chat-user
authorization. A failed retrieval lets the turn continue without knowledge;
a slow call can delay it by up to `timeoutMs`.

```json
{
  "plugins": {
    "list": [
      {
        "id": "hybridai-knowledge",
        "enabled": true,
        "config": {
          "collections": [],
          "limit": 5,
          "maxInjectedChars": 4000,
          "timeoutMs": 3000,
          "maintenance": { "enabled": true, "hourUtc": 3 }
        }
      }
    ]
  }
}
```

`collections` narrows retrieval to named collection ids (see `knowledge_list`);
empty means everything the API key's owner may read. With `maintenance.enabled` the
plugin runs the `llm-wiki` lint workflow once a day on a session of its own:
duplicates merged, orphans linked, pages refreshed from newer sources, missing
`sources/` pages written, at most twelve writes per run.

Needs the `HYBRIDAI_API_KEY` credential, the same key the HybridAI provider
uses; the gateway URL follows `hybridai.baseUrl`.

Retrieval and maintenance skip work when the key is missing or
`mcpServers.hybridai.enabled` is `false`. Both check the current settings before
each run, so removing the key or disabling the connection also stops future
work after startup. With a key and no explicit MCP configuration, HybridClaw's
automatic HybridAI connection remains available.

The plugin acts as the platform user who owns that key: what it can read is
that user's company collections and shared bot collections. On a gateway that
serves several chat users, every one of them gets that user's knowledge; use
`collections` to narrow it, or give such a gateway a key of its own.

Retrieval runs before the prompt is built, so a slow gateway can delay a turn
by up to `timeoutMs`. After a failed or timed-out call the plugin skips
retrieval for a minute, so an outage costs one timeout per minute, not one per
turn. Maintenance may use only knowledge list, read, search and write tools.
The worker rejects write attempts beyond twelve before executing them, even
with hidden progress events or a replacement worker. Ingest is excluded because
it can also mutate collections. Every write is a revision the platform can restore.
