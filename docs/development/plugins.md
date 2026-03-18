# Plugin System

HybridClaw plugins are local runtime extensions discovered from plugin
directories.

## Install Workflow

Use the CLI to install a plugin from a local directory or npm package:

```bash
hybridclaw plugin list
hybridclaw plugin install ./plugins/example-plugin
hybridclaw plugin install @scope/hybridclaw-plugin-example
```

The install command:

- copies the plugin into `~/.hybridclaw/plugins/<plugin-id>/`
- validates `hybridclaw.plugin.yaml`
- installs npm dependencies when the plugin ships a `package.json` or npm
  install hints

`hybridclaw plugin list` shows discovered plugins with source, enabled state,
registered tools/hooks, and any load error.

Required secrets or plugin-specific config values still need to be filled in
after install.

## Discovery And Enablement

Discovery sources:

- `~/.hybridclaw/plugins/<plugin-id>/`
- `<project>/.hybridclaw/plugins/<plugin-id>/`
- explicit `plugins.list[].path` entries from runtime config

Any valid plugin found in the home or project plugin directories is discovered
automatically.

`plugins.list[]` is an override layer, not the activation gate. Use it to:

- disable a discovered plugin with `enabled: false`
- provide plugin-specific config values
- point a plugin id at a custom path outside the default plugin directories

Runtime config shape:

```json
{
  "plugins": {
    "list": [
      {
        "id": "example-plugin",
        "enabled": true,
        "config": {
          "workspaceId": "workspace-a"
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

This lets an external memory or recall system provide long-term context without
becoming the system of record for local session history.
