---
title: Plugin System
description: Plugin manifests, discovery, install flow, config wiring, and runtime hooks in HybridClaw.
sidebar_position: 4
---

# Plugin System

HybridClaw plugins are local runtime extensions discovered from plugin
directories.

## Install Workflow

Use the CLI to install a plugin from a local directory or npm package:

```bash
hybridclaw plugin list
hybridclaw plugin config example-plugin workspaceId workspace-a
hybridclaw plugin install ./plugins/example-plugin
hybridclaw plugin install ./plugins/qmd-memory
hybridclaw plugin install ./plugins/brevo-email
hybridclaw plugin install @scope/hybridclaw-plugin-example
hybridclaw plugin reinstall ./plugins/example-plugin
hybridclaw plugin uninstall example-plugin
```

From a local TUI/web session you can also run:

```text
/plugin config example-plugin workspaceId workspace-a
/plugin install ./plugins/example-plugin
/plugin reinstall ./plugins/example-plugin
/plugin reload
```

The install command:

- copies the plugin into `~/.hybridclaw/plugins/<plugin-id>/`
- validates `hybridclaw.plugin.yaml`
- installs npm dependencies when the plugin ships a `package.json` or npm
  install hints
- disables npm lifecycle scripts during install-time dependency resolution

The reinstall command:

- replaces the existing home install for the plugin id
- preserves existing `plugins.list[]` overrides
- reloads cleanly after code changes from the TUI/web flow

`hybridclaw plugin list` shows discovered plugins with source, enabled state,
registered tools/hooks, and any load error.
The embedded admin console also exposes the same discovery snapshot at
`/admin/plugins` for browser-based inspection.

`hybridclaw plugin uninstall <plugin-id>` removes the home-installed plugin
directory and deletes matching `plugins.list[]` overrides from runtime config.
Project-local plugin directories still need to be deleted manually.

Required secrets or plugin-specific config values still need to be filled in
after install.

Use `plugin config <plugin-id> [key] [value|--unset]` when you want to inspect
or change one top-level `plugins.list[].config` key without editing
`~/.hybridclaw/config.json` by hand.

## Repo-Shipped Examples

- `qmd-memory` injects external markdown retrieval context into prompts
- `brevo-email` provides per-agent email addresses through a Brevo inbound
  webhook plus SMTP relay; configure `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`,
  `BREVO_WEBHOOK_SECRET`, and optional config keys such as `domain`,
  `fromName`, `fromAddress`, and `agentHandles`

Example config writes:

```bash
hybridclaw plugin config brevo-email domain agent.hybridai.one
hybridclaw plugin config brevo-email fromName "HybridClaw Agent"
```

When a reply uses plugin-provided prompt context, the TUI shows a footer such
as `🪼 plugins: qmd-memory`. For deeper verification, inspect
`~/.hybridclaw/data/last_prompt.jsonl`; plugin-injected retrieval appears under
its own `## Retrieved Context` section instead of being merged into generic
session memory.

## How-To

### Change one plugin setting from the TUI

```text
/plugin config qmd-memory searchMode query
/plugin config qmd-memory searchMode
/plugin config qmd-memory searchMode --unset
```

Use `--unset` to remove the override and fall back to the plugin schema
default.

### Pick up local plugin code changes

```text
/plugin reinstall ./plugins/qmd-memory
/plugin reload
```

`install` and `reinstall` copy the plugin into `~/.hybridclaw/plugins/`.
`/plugin reload` reloads the installed copy; it does not sync edits directly
from the repo working tree.

### Know when reload is not enough

- `/plugin reload` reloads plugin modules and runtime registrations.
- Restart the gateway/TUI when HybridClaw core code changed under `src/`.
- Rebuild/reinstall the global `hybridclaw` package if your running binary is
  not using the current repo checkout.

## Tips & Tricks

- Use `/plugin list` first to separate discovery/config problems from retrieval
  problems.
- For `brevo-email`, keep the required Brevo secrets in the encrypted runtime
  store or declared plugin credentials instead of hardcoding them in tracked
  config files.
- If a plugin is enabled but appears unused, inspect
  `~/.hybridclaw/data/last_prompt.jsonl` rather than guessing. Prompt-injection
  plugins leave evidence there even when the final answer is poor.
- `plugins.list[]` is an override layer. Prefer `plugin config ...` for small
  setting changes instead of hand-editing `~/.hybridclaw/config.json`.

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
- runtime requirements under `requires.bins`, `requires.env`, and `requires.node`
- install hints under `install`
- plugin config validation with `configSchema`
- optional UI labels under `configUiHints`

`configSchema` is validated with Ajv, so standard JSON Schema keywords such as
`minLength`, `maxLength`, `pattern`, `minimum`, and `maximum` are enforced.

For `requires.node`, use `>=22` for a minimum supported runtime. A bare numeric
version pins the components you provide: `22` means Node 22.x, `22.3` means
Node 22.3.x, and `22.3.1` means exactly 22.3.1.
Use `requires.bins` for required host executables. Entries can be bare strings
such as `qmd` or objects with `name` plus an optional `configKey` when the
binary path is configurable from plugin config.
If a plugin config allows overriding an executable path, that path is trusted
operator input and is executed directly by the gateway process. HybridClaw does
not sandbox those binaries separately, so only point executable overrides at
programs you trust to run with the gateway's OS-level access.
Plugins can only read environment variables declared in `requires.env` through
`api.getCredential(...)`; undeclared process environment values are not exposed.

## Runtime API

Plugins export a synchronous `register(api)` definition and register runtime
surfaces through `HybridClawPluginApi`.

Currently wired runtime surfaces:

- memory layers
- prompt hooks
- plugin tools
- inbound webhooks on fixed plugin-owned routes
- lifecycle hooks for session, gateway, compaction, and plugin-tool execution
- services
- channels

Provider registration is typed and stored by the manager, but providers are
not yet routed into the broader runtime in the same way as memory layers,
plugin tools, and plugin commands.

Plugins can register inbound webhook handlers through
`api.registerInboundWebhook(...)`. Webhook routes are mounted on the shared
gateway HTTP server under the fixed prefix:

```text
/api/plugin-webhooks/<plugin-id>/<webhook-name>
```

Use the exported `buildPluginInboundWebhookPath(...)` helper from
`@hybridaione/hybridclaw/plugin-sdk` instead of hardcoding the route.
Webhook handlers receive the raw Node `IncomingMessage` and `ServerResponse`
plus the parsed `URL`, and can reuse `readWebhookJsonBody(...)`,
`sendWebhookJson(...)`, and `WebhookHttpError` from the same SDK path.

To hand a normalized inbound event back into the standard assistant turn flow,
plugins can call `api.dispatchInboundMessage(...)`. That runs the same gateway
turn pipeline used by built-in channels and returns the standard gateway chat
result so the plugin can deliver the reply through its own transport.

## Webhook Example

This example shows the intended shape for a plugin that:

- exposes a fixed inbound webhook route
- validates a shared-secret header
- parses JSON with the shared helper
- dispatches a normalized inbound turn into HybridClaw
- returns the assistant reply in the webhook response

```ts
import crypto from 'node:crypto';
import {
  buildPluginInboundWebhookPath,
  readWebhookJsonBody,
  sendWebhookJson,
  WebhookHttpError,
} from '@hybridaione/hybridclaw/plugin-sdk';

export default {
  id: 'webhook-demo',
  register(api) {
    const secret = api.getCredential('WEBHOOK_DEMO_SECRET');

    api.registerInboundWebhook({
      name: 'incoming',
      async handler(context) {
        const supplied = String(
          context.req.headers['x-webhook-demo-secret'] || '',
        ).trim();
        if (!secret || !supplied) {
          throw new WebhookHttpError(401, 'Missing webhook credentials.');
        }

        const suppliedBuffer = Buffer.from(supplied);
        const expectedBuffer = Buffer.from(secret);
        if (
          suppliedBuffer.length !== expectedBuffer.length ||
          !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
        ) {
          throw new WebhookHttpError(401, 'Invalid webhook credentials.');
        }

        const payload = (await readWebhookJsonBody(context.req, {
          maxBytes: 1_000_000,
          tooLargeMessage: 'Webhook body too large.',
          invalidJsonMessage: 'Webhook body must be valid JSON.',
          requireObject: true,
          invalidShapeMessage: 'Webhook body must be a JSON object.',
        })) as {
          from?: string;
          name?: string;
          text?: string;
        };

        const sender = String(payload.from || '').trim().toLowerCase();
        const content = String(payload.text || '').trim();
        if (!sender || !content) {
          throw new WebhookHttpError(
            400,
            'Webhook payload requires `from` and `text`.',
          );
        }

        const result = await api.dispatchInboundMessage({
          sessionId: `agent:main:channel:webhook-demo:dm:${sender}`,
          guildId: null,
          channelId: `webhook-demo:${sender}`,
          userId: sender,
          username: String(payload.name || sender).trim() || sender,
          content,
        });

        sendWebhookJson(context.res, result.status === 'success' ? 200 : 500, {
          ok: result.status === 'success',
          reply: result.result,
          toolsUsed: result.toolsUsed,
          error: result.error || null,
        });
      },
    });

    api.logger.info(
      {
        route: buildPluginInboundWebhookPath(api.pluginId, 'incoming'),
      },
      'Webhook demo plugin registered',
    );
  },
};
```

Expected manifest additions:

```yaml
id: webhook-demo
name: Webhook Demo
kind: tool
requires:
  env:
    - WEBHOOK_DEMO_SECRET
```

With that plugin loaded, the route will be:

```text
/api/plugin-webhooks/webhook-demo/incoming
```

Notes:

- Plugin webhook routes are public gateway routes. Always verify a provider
  signature, HMAC, bearer token, or shared secret inside the handler.
- `api.dispatchInboundMessage(...)` only runs the assistant turn. If your
  transport needs an outbound side effect such as SMTP delivery, Slack reply,
  or provider callback, do that in the plugin after you receive the result.
- If the handler does not write a response, HybridClaw finishes the request
  with `204 No Content`.
- Keep the plugin route stable. External webhook providers will cache the URL.

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
