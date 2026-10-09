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
hybridclaw plugin list available
hybridclaw plugin config example-plugin workspaceId workspace-a
hybridclaw plugin install ./plugins/example-plugin
hybridclaw plugin install ./plugins/gbrain
hybridclaw plugin install ./plugins/honcho-memory
hybridclaw plugin install ./plugins/mem0-memory
hybridclaw plugin install ./plugins/mempalace-memory
hybridclaw plugin install ./plugins/qmd-memory
hybridclaw plugin install ./plugins/transformers-embeddings
hybridclaw plugin install ./plugins/media-tools
hybridclaw plugin install ./plugins/brevo-email
hybridclaw plugin install ./plugins/vonage-voice
hybridclaw plugin install ./plugins/published-tools
hybridclaw plugin install ./plugins/connector-events
hybridclaw plugin install @scope/hybridclaw-plugin-example
hybridclaw plugin reinstall ./plugins/example-plugin
hybridclaw plugin uninstall example-plugin
```

From a local TUI/web session you can also run:

```text
/plugin list available
/plugin config example-plugin workspaceId workspace-a
/plugin install ./plugins/example-plugin
/plugin reinstall ./plugins/example-plugin
/plugin reload
```

The install command:

- copies the plugin into `~/.hybridclaw/plugins/<plugin-id>/`, except for a
  plugin bundled with HybridClaw that has no dependencies to install: that one
  is enabled in place with a `plugins.list[]` entry, so it upgrades together
  with HybridClaw. `plugin reinstall <plugin-id>` replaces a home copy that an
  older release left behind with that entry.
- validates `hybridclaw.plugin.yaml`
- installs npm dependencies when the plugin ships a `package.json` or npm
  install hints
- disables npm lifecycle scripts during install-time dependency resolution

`plugin enable <plugin-id>` uses the same installer and approval flow when the
plugin is registered as available but is not installed yet. This is how
license-sensitive install-on-demand plugins such as WhatsApp and LINE remain
completely outside normal core install, update, build, and test workflows.
WhatsApp installs from a pinned external release archive; LINE is bundled with
HybridClaw as source but keeps its LINEJS dependency closure isolated until the
plugin is explicitly enabled.

Vonage Voice is also bundled as an install-on-demand plugin. Its webhook
runtime, credentials, and outbound calling command stay outside the built-in
Twilio voice channel. Its optional realtime mode reuses the core realtime
voice engine through the plugin API rather than its own model credentials.

The optional [Connector Events plugin](../guides/connector-events.md) accepts
authenticated change notifications from a trusted cloud relay and queues an
existing owned proactive policy. Phone snapshot changes use the same scheduler
path directly.

The reinstall command:

- replaces the existing home install for the plugin id
- preserves existing `plugins.list[]` overrides
- reloads cleanly after code changes from the TUI/web flow

`hybridclaw plugin list` shows installed/discovered plugins first, then
installable bundled or project-local plugins. Use `hybridclaw plugin list
installed` or `hybridclaw plugin list available` to show only one section.
When installing by bare plugin id, a plugin bundled with HybridClaw takes
priority over a project-local `./plugins/<id>` with the same id, so running the
install from a source checkout still enables the packaged copy.
An exact npm package name also resolves to a matching `package.json` in those
local plugin catalogs before HybridClaw contacts the registry. This lets the
same canonical install source work in a source checkout and in packaged
releases after the package is published.
The embedded admin console also exposes the same discovery snapshot at
`/admin/extensions?tab=plugins` for browser-based inspection.

`hybridclaw plugin uninstall <plugin-id>` removes the home-installed plugin
directory and deletes matching `plugins.list[]` overrides from runtime config.
Project-local plugin directories still need to be deleted manually.

Required secrets or plugin-specific config values still need to be filled in
after install.

Use `plugin config <plugin-id> [key] [value|--unset]` when you want to inspect
or change one top-level `plugins.list[].config` key without editing
`~/.hybridclaw/config.json` by hand. It rejects a key, or a property nested in
the value, that the plugin's `configSchema` does not declare. Undeclared keys
in a hand-edited config are dropped when the plugin loads.

## Repo-Shipped Examples

- `byterover-memory` mirrors turns into ByteRover, injects prompt-time recall
  through `brv query`, and exposes `brv_query`, `brv_curate`, and `brv_status`
  tools. Works offline with optional cloud sync.
- `gbrain` shells out to the GBrain CLI, injects search results into prompt
  context, and mirrors the discovered GBrain operations as `gbrain_*` plugin
  tools
- `honcho-memory` mirrors HybridClaw turns into Honcho, injects prompt-time
  recall, and exposes direct Honcho tools while keeping built-in memory active
- `mem0-memory` mirrors HybridClaw turns into Mem0 cloud memory, injects
  prompt-time recall, and exposes direct `mem0_*` tools while keeping
  built-in memory active
- `mempalace-memory` layers MemPalace recall on top of native memory, mirrors
  turns back into MemPalace, and can route prompt-time retrieval through CLI
  helpers or an active `mempalace` MCP server
- `qmd-memory` injects external markdown retrieval context into prompts
- `media-tools` provides `image_generate`, `video_generate`, and
  `audio_transcribe`. Provider calls run in the gateway with keys from the
  secret store (or the session model's credentials), so no provider key enters
  the sandbox. Reference media and outputs go through `api.media`
- `transformers-embeddings` registers the `transformers` embedding provider
  for built-in semantic memory, running a local Transformers.js (ONNX) model
  in a worker thread; select it with `memory.embedding.provider`
- `output-guard` registers `post_receive` middleware that checks final
  responses against configured policy guidance, banned phrases or regexes,
  required phrases, and optional classifier/rewriter models. It can flag,
  rewrite, or block non-compliant output before the message is returned to the user.
- `concierge-router` registers routing middleware and `/concierge` commands to
  ask or infer urgency before model selection, then map `asap`, `balanced`, and
  `no_hurry` profiles to configured execution models. It stores pending choice
  state under the runtime home and exposes an authorized plugin webhook for
  urgency-button callbacks.
- `brevo-email` provides per-agent email addresses through a Brevo inbound
  webhook plus SMTP relay; configure `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`,
  `BREVO_WEBHOOK_SECRET`, and optional config keys such as `domain`,
  `fromName`, `fromAddress`, and `agentHandles`. The bundled `send_email` tool
  also accepts optional `inReplyTo` and `references` Message-ID headers when
  you need to continue an existing email thread.
- `vonage-voice` provides signed inbound and outbound phone calls through
  Vonage Voice without adding Vonage configuration to the core voice channel —
  turn-based by default, or realtime speech-to-speech with `mode: realtime`.
- `distill` adds human distillation: the `hybridclaw coworker` CLI and the
  admin console Distill page (`/api/admin/distill`). It ships in the npm
  package but loads only once installed (`hybridclaw plugin install distill`);
  see [Human Distillation](../guides/human-distillation.md).
- `published-tools` serves admin-defined tools on an MCP endpoint (protocol
  `2026-07-28`) so hosts such as Microsoft Copilot can hand tasks to an agent;
  see [Published Tools (MCP)](../guides/published-tools.md).

Example config writes:

```bash
hybridclaw plugin config brevo-email domain agent.hybridai.one
hybridclaw plugin config brevo-email fromName "HybridClaw Agent"
hybridclaw plugin config output-guard mode rewrite
hybridclaw plugin config output-guard policy "Clear, direct, concrete, no hype."
```

When a reply uses plugin-provided prompt context, the TUI shows a footer such
as `🪼 plugins: gbrain` or `🪼 plugins: qmd-memory`. For deeper verification,
inspect `~/.hybridclaw/data/last_prompt.jsonl`; plugin-injected retrieval
appears under its own `## Retrieved Context` section instead of being merged
into generic session memory.

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
automatically. The `hybridclaw <command>` CLI is the exception: it never
discovers project plugins, so a checkout's `.hybridclaw/plugins/<id>` cannot
replace the plugin that provides a CLI command.

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
- `memoryProvider: true` for plugins that act as an external memory provider
- runtime requirements under `requires.bins`, `requires.env`, and `requires.node`
- `credentials` for optional `/secret` or environment-backed plugin credentials
- install hints under `install`
- plugin config validation with `configSchema`
- optional UI labels under `configUiHints`
- top-level CLI commands under `cliCommands`, each with a `name` and a
  `description` (see `registerCliCommand` below)

`memoryProvider: true` is intentionally narrower than `kind: memory`. Use it
only for plugins that should behave like a primary external memory system.
HybridClaw keeps built-in memory on at all times and allows at most one active
external memory provider, while other `kind: memory` plugins can still inject
retrieval or prompt context in parallel.

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
Plugins can only read credentials declared in `requires.env` or `credentials`
through `api.getCredential(...)`; undeclared process environment values are not
exposed. Use `requires.env` when the plugin must not load without the value, and
use `credentials` when the value is optional but should still be readable from
`/secret` or the process environment.

## Runtime API

Plugins export a synchronous `register(api)` definition and register runtime
surfaces through `HybridClawPluginApi`.

Currently wired runtime surfaces:

- memory layers
- memory embedding providers (`registerEmbeddingProvider`)
- prompt hooks
- classifier middleware with `pre_send` and `post_receive` hooks
- plugin tools
- inbound webhooks on fixed plugin-owned routes
- authenticated admin API routes under `/api/admin/<plugin-id>`
  (`registerAdminRoute`)
- top-level CLI commands (`registerCliCommand`)
- lifecycle hooks for session, gateway, compaction, and plugin-tool execution
- services
- channels
- channel transports

`session_end` runs for the previous session instance on explicit reset, clear,
new-session creation, session switching, and automatic expiry. It runs before
`session_reset` and before the manager releases the previous instance's user and
workspace context. Gateway session deletion (including pruning and empty-chat
cleanup) awaits `session_end` while the session history is still available.
Plugin handler failures are logged and do not prevent reset or deletion.

Provider registration is typed and stored by the manager, but providers are
not yet routed into the broader runtime in the same way as memory layers,
plugin tools, and plugin commands.

### Phone notifications

`api.notifyPhones({ sessionId, kind, title, body, badge, data })` alerts the
phones registered by whoever opened `sessionId` in web chat, for example the
session an app sends the plugin's command from. Only phones that registered
`kind` with `/push register` get it, and only those of the HybridAI app the
session was last chatted in from. `title` and `body` show on the lock
screen; `data` holds flat keys delivered next to `aps` for the app to route
by. The result counts the phones that take `kind` (`devices`) and those the
alert reached APNs for (`sent`). While the owner is at a computer the alert
waits and `sent` is 0; it rings when they leave
([Quiet while you are at a computer](../guides/web-notifications.md#quiet-while-you-are-at-a-computer)).
The gateway does not deduplicate plugin alerts. See [Web chat notifications](../guides/web-notifications.md#phones).

### Tools that read or write media

Plugin tool handlers receive `context.media`, the attachments of the turn that
called the tool as the sandbox saw them. `api.media` resolves the rest without
giving the plugin new reach:

- `resolveInputPath(sessionId, path, media)` maps a sandbox path under
  `/workspace`, `/discord-media-cache` (current turn only), or
  `/uploaded-media-cache` to the host file through the same allowed-roots check
  the gateway uses for inbound audio, or returns `null`.
- `fetchRemote(url, { maxBytes, timeoutMs, discordCdnOnly })` is an HTTPS GET
  whose every DNS answer must be public.
- `getSessionModelCredentials(sessionId)` returns the session model's provider,
  base URL, key, and headers, for tools that fall back to them.
- Outputs go under `api.getSessionInfo(sessionId).workspaceRoot` and are
  reported to the agent under `api.media.workspaceDisplayRoot`.

Plugin tool calls from the sandbox wait up to 20 minutes for a result, so
long-running provider jobs such as video generation fit in one call.

### Channel transport plugins

A channel plugin supplies a transport for one of the install-on-demand channel
kinds listed in `src/channels/channel-plugin-catalog.ts` through
`api.registerChannelTransport(...)`. Registering any other kind throws; a
plugin does not create arbitrary new kinds or take over a built-in channel.

The registration is everything core knows about the channel. Core owns the
config section, the generic runtime, gateway turns, proactive delivery, and
the message tool; it asks the registration for the channel-specific facts:

| Member | Required | Used by |
|---|---|---|
| `create(host)` | yes | The runtime, once per transport instance |
| `matchesTarget(target)` | yes | Session, scheduler, and proactive target classification |
| `normalizeTarget(target)` | yes | Message-tool targets: `null` if not yours, throw if yours but malformed |
| `getAuthStatus()` | yes | Gateway status, doctor, sends; returns `linked` plus fields gateway status publishes |
| `resetAuth()` | yes | `hybridclaw auth <kind> reset` and `channels <kind> setup --reset`; returns the cleared directory |
| `getPairingState()` | no | The admin console pairing prompt (`pairingQrText`, `updatedAt`, `error`, extra fields) |
| `doctorChecks({ enabled })` | no | `hybridclaw doctor` findings |
| `messageToolHints({ channelId })` | no | Channel-specific lines in the agent prompt |
| `describeSend({ target, auth })` | no | `sentFrom`, `recipient`, and `note` on message-tool results |

```js
import path from 'node:path';

export default {
  id: 'line',
  register(api) {
    // The plugin owns its credentials; keep the 0.39.1 path so pairings survive.
    const authDir = path.join(api.runtime.homeDir, 'credentials', 'line');
    api.registerChannelTransport({
      kind: 'line',
      create(host) {
        return {
          async init(handler) {},
          async shutdown() {},
          async sendText(chatId, text) {},
          async sendMedia(params) {},
        };
      },
      matchesTarget: (target) => target.startsWith('line:'),
      normalizeTarget: (target) => (target.startsWith('line:') ? target : null),
      getAuthStatus: async () => ({ linked: false, mid: null }),
      resetAuth: async () => authDir,
    });
  },
};
```

Installed plugins are loaded from an isolated snapshot with only their own
`node_modules` available. Plugin runtime code must not import HybridClaw core
modules. Core services (configuration for the channel's section, logging,
media and text helpers, session keys, rate limiting, QR rendering) are passed
as values on the `ChannelTransportHost`; credential storage, locks, pairing
state, and target syntax belong to the plugin. Core SDK imports should be
type-only so they are erased from emitted JavaScript.

While a channel plugin is registered, its `matchesTarget` decides which ids
belong to the channel. Without the plugin, core still recognizes the ids that
sessions already store for that channel (a catalog pattern such as `line:`),
so they fail with the install command instead of reaching another channel.

The released WhatsApp plugin (0.1.x) still registers only `{ kind, create }`
and expects auth, pairing, and phone helpers on its host. Core adapts that one
registration through `src/channels/whatsapp/legacy-registration.ts` until the
plugin ships the full contract; any other create-only registration is refused
with a `hybridclaw plugin reinstall` hint.

Keep `register(api)` synchronous and cheap. If a transport has large or
license-sensitive dependencies, register a lightweight instance and dynamically
import the implementation when `init`, send, or pairing is first used. The
plugin manager rolls back transport registrations when registration fails and
unregisters them during shutdown; the core runtime retains an active instance
long enough to shut it down cleanly.

Install-on-demand channel plugins also need an entry in
`src/channels/channel-plugin-catalog.ts`. The catalog is core-owned because a
plugin that is not installed cannot expose its own manifest. Each entry maps a
closed channel kind to its plugin id and install source, plus the enablement
and restart rules for the channel's core-owned config section. Gateway status derives
transport availability from that catalog, and the admin Channels page uses the
same metadata to show a generic install action. Adding another plugin-backed
channel should require a catalog entry, not channel-specific install UI.

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

### Admin routes and CLI commands

`api.registerAdminRoute({ method, path, rbacAction, handler })` adds an
operator API route for the admin console. Unlike inbound webhooks, these
routes sit behind the gateway's normal admin authentication:

- `method` is `GET`, `POST`, or `DELETE`.
- `path` is `/api/admin/<plugin-id>` or a child of it. A `:name` segment
  captures one path segment; the decoded value arrives as `params.name`.
- `rbacAction` must be an action from the core RBAC catalog
  (`src/security/admin-rbac.ts`); the gateway checks it before the handler
  runs, so scoped API tokens and sessions need that action. A plugin that
  needs actions of its own adds `admin.<plugin-id>.<verb>` entries to
  `PLUGIN_ADMIN_RBAC_ACTIONS` there; manifests cannot declare actions. While
  such a plugin is not loaded, every caller gets 404 for its namespace, so
  the console can tell "not installed" apart from "forbidden".
- Registration throws on an unknown method or action, a path outside the
  plugin's namespace, a path core already serves, or a path that overlaps
  another registered route. A known path with another method answers 405.

Handlers receive `{ req, res, url, params }`, write the
response themselves, and throw `WebhookHttpError` for an error status.

`api.registerCliCommand({ name, run })` adds a top-level `hybridclaw <name>`
command that the manifest declares under `cliCommands`:

```yaml
cliCommands:
  - name: coworker
    description: Distill a human's source material into a coworker agent
```

The CLI looks plugin commands up only for names no built-in command handles,
and routes by manifest: it imports only the one plugin that declares the name,
register-only (no services, memory layers, or gateway hooks start), and opens
the runtime database before `run(args)`. A name no manifest declares loads no
plugin code; a name two enabled plugins declare fails. Project plugins
(`<cwd>/.hybridclaw/plugins`) never provide CLI commands, so running
`hybridclaw` inside an untrusted checkout does not execute its plugin code. A
name that only a bundled, not-installed plugin declares fails with that
plugin's install command. Plugin-manager logs go to stderr, so the command
owns stdout. `hybridclaw help` lists the declared
commands of installed plugins, and `hybridclaw help <name>` runs
`<name> --help`. Registering a command the manifest does not declare fails.

The plugin SDK also exports the host services a plugin should reuse rather
than copy: `readWebhookBody` / `readWebhookJsonBody` for size-capped request
bodies, `parseValueFlag` for `--flag value` / `--flag=value` CLI parsing,
`recordAuditEvent`, `syncRuntimeAssetRevisionState` /
`clearRuntimeAssetRevisions` (F4 revisions), the confidential-rule helpers
(`loadConfidentialRules`, `dehydrateConfidential`, `scanForLeaks`), and the
agent registry and workspace helpers. The `distill` plugin uses all of these.

To hand a normalized inbound event back into the standard assistant turn flow,
plugins can call `api.dispatchInboundMessage(...)`. That runs the same gateway
turn pipeline used by built-in channels and returns the standard gateway chat
result so the plugin can deliver the reply through its own transport. The
request accepts an optional `onToolProgress` callback for live tool activity
during the turn. `allowedTools` narrows the tools the turn may use (intersected
with the agent's own tool list and enforced at dispatch), and `instructions`
adds trusted operator text to the system prompt. Never put caller-supplied
content in `instructions`; send it as `content`.

Plugins can also register websocket endpoints on the same route prefix through
`api.registerWebsocketWebhook({ name, handler })`. The handler receives the
upgrade request plus `accept()` / `reject(statusCode, message)`; exactly one
must be called. Like HTTP plugin webhooks, the gateway performs no peer
authentication on these upgrades — the handler must validate the peer itself
(for example with a signed single-use token in the URL) before accepting.

Channel plugins that transport live phone audio can open a realtime
speech-to-speech session with `api.createRealtimeVoiceSession(...)`. The core
realtime engine (configured by `speech.realtime.*`) fronts the conversation,
consults the full agent through the plugin dispatch pipeline (so approvals,
audit, and session history behave like any other turn), and persists spoken
turns as voice transcripts. Transport audio is 16-bit LE mono PCM at 8 kHz;
model audio arrives as 20 ms frames as soon as the model produces them, with
a bounded amount in flight, and the optional `clearAudio` callback is invoked
on barge-in so the transport can drop what the far end has buffered.
`api.isRealtimeVoiceAvailable()` reports whether realtime
credentials are configured. The bundled `vonage-voice` plugin's realtime mode
is the reference implementation.

Classifier middleware uses one decision shape for routing, inbound prompt
preparation, and outbound response inspection:

```ts
api.registerMiddleware({
  id: 'classifier-demo',
  priority: 100,
  async routing(context) {
    return { action: 'allow' };
  },
  async pre_send(context) {
    return { action: 'allow' };
  },
  async post_receive(context) {
    if (!context.resultText?.includes('forbidden phrase')) {
      return { action: 'allow' };
    }
    return {
      action: 'transform',
      payload: context.resultText.replaceAll('forbidden phrase', '[redacted]'),
      reason: 'Removed blocked wording.',
    };
  },
});
```

Middleware decisions are `allow`, `warn`, `block`, `transform`, or `escalate`.
The manager runs middleware in ascending `priority` order, then by `id`.
The `routing` phase runs before model/provider selection and may attach
decision `metadata` for gateway routing hints. Ordinary `pre_send` middleware
runs after prompt assembly and should remain the default for prompt edits.
Legacy `registerOutputGuard(...)` plugins are adapted into `post_receive`
middleware for compatibility. `post_receive` contexts include final response
text and the turn's `toolExecutions`, including F8 stakes metadata populated by
the approval policy.

Bundled skills can declare their middleware hooks in `SKILL.md` frontmatter so
skill discovery can expose the same contract alongside plugin registration:

```yaml
metadata:
  hybridclaw:
    middleware:
      pre_send: true
      post_receive: true
```

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

### Local decision classifiers

`api.registerLocalClassifier(...)` registers an optional `local-decision/<id>`
routing model with `status`, `command` (`setup`, `start`, `stop`) and `predict`
callbacks. The gateway validates the returned typed choice against its tier
ladder and applies its confidence threshold. It does not treat these models as
chat providers. Plugins declare local execution as trusted host code; the
registration is not a network sandbox.

The first caller is `plugins/laya-router`. Its MLX dependency and model live in
an isolated, explicitly installed runtime; inference uses an offline child pipe.
Labs controls require admin authentication and loopback access for mutations.
Register a service `stop` callback to clean up on gateway shutdown; registration
snapshots roll back failed loads. See the plugin README for setup and limits.
