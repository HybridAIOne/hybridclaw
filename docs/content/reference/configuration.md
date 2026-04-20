---
title: Configuration
description: Runtime files, major config keys, and where HybridClaw stores its state.
sidebar_position: 3
---

# Configuration

HybridClaw creates `~/.hybridclaw/config.json` on first run and hot-reloads
most runtime settings.

Use `config.example.json` as the reference shape when you need to inspect the
full runtime config surface before editing your local file.

Use `hybridclaw config` to print the active runtime config,
`hybridclaw config check` to validate only the config file itself,
`hybridclaw config reload` to force an immediate in-process hot reload from
disk, `hybridclaw config set <key> <value>` to edit an existing dotted key
path without rewriting the whole file manually, and
`hybridclaw config revisions [list|rollback <id>|delete <id>|clear]` to audit
or restore tracked config snapshots.

## Runtime Files

- `~/.hybridclaw/config.json` for typed runtime config
- `~/.hybridclaw/credentials.json` for encrypted runtime secrets
- `~/.hybridclaw/credentials.master.key` for the local owner-only fallback
  master key when no external key source is configured
- `~/.hybridclaw/codex-auth.json` for Codex OAuth state
- `~/.hybridclaw/data/hybridclaw.db` for persistent runtime data
- `~/.hybridclaw/data/config-revisions.db` for tracked runtime config history
- `~/.hybridclaw/data/memory-consolidation-state.json` for the last successful
  dream-consolidation timestamp
- `~/.hybridclaw/data/browser-profiles/` for shared browser login state
- `~/.hybridclaw/data/uploaded-media-cache/` for shared locally staged inbound
  media from built-in channel transports such as email, Telegram, WhatsApp,
  and Microsoft Teams
- `~/.hybridclaw/data/agents/` for agent workspaces, session files, and related
  runtime state

HybridClaw does not keep runtime state in the current working directory. If
`./.env` exists, supported secrets are imported once for compatibility.
Headless or containerized deployments should prefer `HYBRIDCLAW_MASTER_KEY` or
`/run/secrets/hybridclaw_master_key` instead of the local fallback key file.
Set `HYBRIDCLAW_DATA_DIR` to an absolute path when you want to relocate the
entire runtime home, including config, credentials, SQLite data, browser
profiles, and agent workspaces.

## Config Revision History

HybridClaw records runtime config snapshots whenever `config.json` changes
through the CLI, gateway commands, or background reload paths.

- `hybridclaw config revisions` lists tracked snapshots with actor, route,
  timestamp, and content hash metadata
- `hybridclaw config revisions rollback <id>` restores one saved snapshot back
  into `config.json`
- `hybridclaw config revisions delete <id>` removes one saved snapshot
- `hybridclaw config revisions clear` deletes the stored history for the active
  config file

Tracked routes are sanitized before storage so host-specific home paths do not
leak into the saved revision metadata.

## Recovery From Invalid Config Files

If `~/.hybridclaw/config.json` becomes invalid JSON, HybridClaw records the
load error and falls back to in-memory defaults until the file is repaired.

Interactive `hybridclaw onboarding` and related local setup flows can then:

- restore the last known-good saved config snapshot when one exists
- otherwise roll back to the newest saved config revision from
  `~/.hybridclaw/data/config-revisions.db`
- otherwise tell you to repair `config.json` manually before rerunning setup

Use `hybridclaw config revisions` any time you want to inspect or restore the
saved revision history directly.

## Important Config Areas

- `container.*` for execution isolation, including `sandboxMode`, `memory`,
  `memorySwap`, `cpus`, `network`, `binds`, additional mounts, and
  `persistBashState`
- `container.persistBashState` controls whether `bash` tool calls reuse shell
  state (`cd`, exported env vars, aliases) for the active runtime session
  (`true`, default) or start fresh on each call (`false`)
- `container.binds` for explicit host-to-container mounts in
  `host:container[:ro|rw]` format; mounted paths appear inside the sandbox
  under `/workspace/extra/<container>`
- `ops.healthHost` and `ops.healthPort` for the gateway HTTP bind address and
  port; the default is loopback on `127.0.0.1:9090`
- `observability.*` for HybridAI audit-event forwarding, ingest batching, and
  runtime status reporting, including the target base URL, bot and agent ids,
  flush interval, and batch size
- `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_PROTOCOL`, and `OTEL_SERVICE_NAME` for optional built-in
  distributed tracing export to OTLP collectors; see
  [Runtime Internals](../developer-guide/runtime.md)
- `hybridai.baseUrl` for the HybridAI API origin; `HYBRIDAI_BASE_URL` can
  override it for the current process without rewriting `config.json`
- `hybridai.maxTokens` for the default completion output budget; the shipped
  default is `4096`; you can change it live with
  `hybridclaw config set hybridai.maxTokens <n>`
- `mcpServers.*` for Model Context Protocol servers; HybridClaw connects to
  them per session and exposes their tools as namespaced functions such as
  `server__tool`
- `sessionReset.*` for daily and idle reset policy; the default policy resets
  both daily and after 24 hours idle at `04:00` in the gateway host's local
  timezone, and `sessionReset.defaultPolicy.mode = "none"` disables automatic
  resets
- `sessionRouting.*` for DM continuity scope and linked identities; the default
  `per-channel-peer` mode keeps DMs isolated by transport and peer identity,
  while `per-linked-identity` plus `sessionRouting.identityLinks` collapses
  verified aliases onto one shared main session
- `memory.decayRate`, `memory.consolidationIntervalHours`,
  `memory.consolidationLanguage`, `memory.semanticPromptHardCap`,
  `memory.embedding.*`, `memory.queryMode`, `memory.backend`,
  `memory.rerank`, and `memory.tokenizer` for built-in
  memory cleanup, prompt-time semantic recall limits, and live semantic
  retrieval behavior (`memory.backend` accepts `cosine`, `full-text`, or
  `hybrid`, while `memory.tokenizer` accepts `unicode61`, `porter`, or
  `trigram`; `memory.embedding.provider` accepts `hashed` or
  `transformers`, with the Transformers.js provider configured by
  `memory.embedding.model`, `memory.embedding.revision`, and
  `memory.embedding.dtype`); `0`
  disables scheduled runs, `24` matches `dream on`, and `dream now` triggers
  an immediate local consolidation run
- `agents.defaultAgentId` for the default agent used by new requests and fresh
  web sessions when no agent is pinned explicitly
- `channelInstructions.*` for transport-specific prompt guidance injected into
  the runtime prompt; `channelInstructions.voice` is the right place for
  spoken-style rules such as "no markdown" or "keep replies short"
- `skills.disabled` and `skills.channelDisabled.*` for skill availability
- `plugins.list[]` for plugin overrides and config; use
  `hybridclaw plugin config <plugin-id> [key] [value|--unset]` for focused
  edits
- `adaptiveSkills.*` for skill observation, amendment staging, and rollback
- `imessage.*` for the dual-backend local or BlueBubbles iMessage transport;
  prefer storing the BlueBubbles password as `IMESSAGE_PASSWORD` in the
  encrypted secret store instead of plaintext config
- `telegram.*` for the Telegram Bot API transport; prefer storing the bot token
  as `TELEGRAM_BOT_TOKEN` or `telegram.botToken` via SecretRef instead of
  plaintext config; a running gateway usually hot-reloads Telegram config
  changes by restarting the integration in place
- `email.*` for the IMAP/SMTP transport; prefer storing the password as
  `EMAIL_PASSWORD` or `email.password` via SecretRef instead of plaintext
  config, and note that `email.pollIntervalMs` defaults to `30000`
  milliseconds and is clamped to a minimum of `1000`
- `voice.*` for the Twilio ConversationRelay channel, including webhook path,
  concurrency, relay voice/STT options, and Twilio number/account settings;
  the auth token can stay empty in config when you store `TWILIO_AUTH_TOKEN`
  in the encrypted runtime secret store or use a SecretRef-backed
  `voice.twilio.authToken`
- `ops.webApiToken` or `WEB_API_TOKEN` for `/chat`, `/agents`, and `/admin`;
  when unset, localhost browser access stays open without a login prompt
- `ops.gatewayBaseUrl` plus `ops.gatewayApiToken` or `GATEWAY_API_TOKEN` for
  the local TUI, eval workflows, and client-side gateway commands that should
  target an already-running HybridClaw instance; if `ops.gatewayApiToken` is
  unset, the runtime falls back to the web token automatically
- `tools.httpRequest.authRules[]` for gateway-side URL-to-secret header
  injection used by the `http_request` tool, for example mapping a URL prefix
  such as `https://staging.hybridai.one/api/v1/` to an auth header plus a
  stored secret ref
- `media.audio` for inbound audio transcription backend selection

Operator-facing controls for `skills.disabled`, `skills.channelDisabled.*`,
and `adaptiveSkills.*` are covered in
[Skills Internals](../extensibility/skills.md) and
[Adaptive Skills](../extensibility/adaptive-skills.md).
For the dual-backend iMessage workflow, see
[Setting Up iMessage](../channels/imessage.md).
For SSH tunnels, host-managed Tailscale, and the macOS LaunchAgent tunnel
pattern, see [Remote Access](../guides/remote-access.md).

## Shared Inbound Media Staging

When built-in channel transports need to materialize inbound attachments
locally, they stage them under `~/.hybridclaw/data/uploaded-media-cache/`
instead of per-channel temp directories.

- In host sandbox mode, media items point at the host path directly.
- In container sandbox mode, the same files are exposed to the runtime as
  `/uploaded-media-cache/...`.
- The shared cache is pruned automatically, so these paths are meant for
  short-lived inbound media handling rather than permanent storage.

## Audio Transcription Notes

`media.audio` auto-detect prefers local CLIs first
(`sherpa-onnx-offline`, `whisper-cli`, `whisper`), then `gemini`, then
provider-backed APIs (`openai`, `groq`, `deepgram`, `google`).

`whisper-cli` auto-detect also requires a whisper.cpp model file. If the
binary exists but HybridClaw still skips local transcription, set
`WHISPER_CPP_MODEL` to a local `ggml-*.bin` model path.

If no transcript backend is available, HybridClaw can still fall back to
native model audio input for supported sessions. Today that path is enabled for
`vllm` and attaches the original current-turn audio when no transcript block
was prepended already.

For the Twilio phone channel, see [Twilio Voice](../guides/twilio-voice.md).
For the local speech and fallback workflow, see
[Voice And TTS](../guides/voice-tts.md).

## Secrets And Trust

Keep runtime secrets in the encrypted `~/.hybridclaw/credentials.json` store.
Common built-in entries include `HYBRIDAI_API_KEY`, `OPENROUTER_API_KEY`,
`MISTRAL_API_KEY`, `HF_TOKEN`, `OPENAI_API_KEY`, `GROQ_API_KEY`,
`DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`,
`XAI_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`, `MINIMAX_API_KEY`,
`DASHSCOPE_API_KEY`, `XIAOMI_API_KEY`, `KILO_API_KEY`, `VLLM_API_KEY`,
`BRAVE_API_KEY`, `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
`TELEGRAM_BOT_TOKEN`, `EMAIL_PASSWORD`, `IMESSAGE_PASSWORD`,
`TWILIO_AUTH_TOKEN`, `MSTEAMS_APP_PASSWORD`, `WEB_API_TOKEN`, and
`GATEWAY_API_TOKEN`.

Local TUI/web sessions and the local CLI manage this store through:

```bash
hybridclaw secret list
hybridclaw secret set <NAME> <VALUE>
hybridclaw secret show <NAME>
hybridclaw secret unset <NAME>
hybridclaw secret route list
hybridclaw secret route add <url-prefix> <secret-name> [header] [prefix|none]
hybridclaw secret route remove <url-prefix> [header]
```

```text
/secret list
/secret set <NAME> <VALUE>
/secret show <NAME>
/secret unset <NAME>
/secret route list
/secret route add <url-prefix> <secret-name> [header] [prefix|none]
/secret route remove <url-prefix> [header]
```

- secret names must use uppercase letters, digits, and underscores
- built-in runtime keys and arbitrary named secrets share the same encrypted
  store
- `/secret route ...` is a convenience surface for editing
  `tools.httpRequest.authRules[]` without hand-editing `config.json`

Codex OAuth sessions are stored separately in `~/.hybridclaw/codex-auth.json`.
Trust-model acceptance is persisted in `config.json` under `security.*` and is
required before runtime start. In headless environments,
`HYBRIDCLAW_ACCEPT_TRUST=true` can persist acceptance automatically before
credential checks run.

## Security Notes

- selected secret-bearing config fields support SecretRefs such as
  `{ "source": "store", "id": "SECRET_NAME" }`,
  `{ "source": "env", "id": "ENV_VAR" }`, or `${ENV_VAR}` shorthand instead of
  plaintext values
- current built-in SecretRef surfaces include `ops.webApiToken`,
  `ops.gatewayApiToken`, `email.password`, `imessage.password`,
  `voice.twilio.authToken`, and `local.backends.vllm.apiKey`
- `mcpServers.*.env` and `mcpServers.*.headers` are currently stored in plain
  text in `config.json`
- In `host` sandbox mode, the agent can access the user home directory, the
  gateway working directory, `/tmp`, and any host paths explicitly added
  through `container.binds` or `container.additionalMounts`
- prefer storing BlueBubbles credentials as `IMESSAGE_PASSWORD` in the
  encrypted secret store instead of plaintext `imessage.password`
- prefer storing email passwords as `EMAIL_PASSWORD` or a SecretRef-backed
  `email.password` value instead of plaintext config
- keep `~/.hybridclaw/` permissions tight (`0700` on the directory, `0600` on
  secret-bearing files)
- prefer low-privilege tokens
- use `host` sandbox mode for stdio MCP servers that depend on host-installed
  tools

For deeper runtime behavior, see [Runtime Internals](../developer-guide/runtime.md).
For the trust acceptance policy, see [`TRUST_MODEL.md`](https://github.com/HybridAIOne/hybridclaw/blob/main/TRUST_MODEL.md).
For technical security guidelines, see [`SECURITY.md`](https://github.com/HybridAIOne/hybridclaw/blob/main/SECURITY.md).
