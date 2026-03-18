# Plugin System

HybridClaw plugins are local runtime extensions discovered from plugin
directories and enabled explicitly in `~/.hybridclaw/config.json`.

## Discovery And Enablement

Discovery sources:

- `~/.hybridclaw/plugins/<plugin-id>/`
- `<project>/.hybridclaw/plugins/<plugin-id>/`
- explicit `plugins.list[].path` entries from runtime config

HybridClaw only loads plugins that are listed in `plugins.list[]` with
`enabled: true`. Discovery alone does not activate a plugin.

Runtime config shape:

```json
{
  "plugins": {
    "list": [
      {
        "id": "honcho-memory",
        "enabled": true,
        "config": {
          "workspaceId": "hybridclaw-prod",
          "environment": "production",
          "autoCapture": true,
          "autoRecall": true
        }
      }
    ]
  }
}
```

## Plugin Layout

Each plugin directory must contain `hybridclaw.plugin.yaml` plus a loadable
entrypoint such as `index.js`, `dist/index.js`, or `index.ts`.

Minimal manifest:

```yaml
id: example-plugin
name: Example Plugin
version: 1.0.0
kind: tool
description: Example HybridClaw plugin
configSchema:
  type: object
  properties:
    enabled:
      type: boolean
      default: true
```

The manifest supports:

- identity fields such as `id`, `name`, `version`, `description`, `kind`
- runtime requirements under `requires.env` and `requires.node`
- install hints under `install`
- plugin config validation with `configSchema`
- optional UI labels under `configUiHints`

## Runtime API

Plugins export a synchronous `register(api)` definition and register runtime
surfaces through `HybridClawPluginApi`.

Currently wired runtime surfaces:

- memory layers
- prompt hooks
- plugin tools
- lifecycle hooks for session, gateway, compaction, and plugin-tool execution
- services
- channels

Provider and command registration are typed and stored by the manager, but they
are not yet routed into the broader runtime in the same way as memory layers
and plugin tools.

Type exports for external plugins are available from:

```ts
import type { HybridClawPluginDefinition } from '@hybridaione/hybridclaw/plugin-sdk';
```

## Memory Layers

Memory plugins compose alongside HybridClaw's built-in SQLite session storage.
They do not replace the local store.

Gateway turn flow:

1. HybridClaw loads recent local session state from SQLite.
2. Registered memory layers can add prompt context before the agent turn.
3. The normal agent turn runs unchanged.
4. HybridClaw persists the turn to SQLite.
5. Memory layers receive the completed turn asynchronously.

This lets an external system such as Honcho provide long-term recall without
becoming the system of record for local session history.

## Honcho Example

The repository includes a proof-of-concept Honcho plugin sample in:

- `docs/development/honcho-memory.hybridclaw.plugin.yaml`
- `docs/development/honcho-memory.index.ts`
- `docs/development/honcho-memory.package.json`

The sample installs under `~/.hybridclaw/plugins/honcho-memory/` and registers:

- a memory layer for prompt recall and async capture
- a `honcho_query` tool
- lifecycle cleanup hooks for session reset and gateway shutdown
