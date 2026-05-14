---
title: Discord Incoming Webhook
---

`discord_webhook` is an outbound-only Discord channel for posting messages through Discord Incoming Webhook URLs. It does not need a Discord bot token, gateway connection, slash commands, inbound events, reactions, uploads, components, or threads.

## Configure

```bash
hybridclaw channels discord_webhook setup \
  --webhook-url https://discord.com/api/webhooks/... \
  --target default
```

Named targets are supported after the default target is configured:

```bash
hybridclaw channels discord_webhook setup \
  --target ops \
  --webhook-url https://discord.com/api/webhooks/...
```

HybridClaw stores each full webhook URL as a runtime secret, writes only a SecretRef to runtime config, and adds a managed POST-only network policy grant scoped to Discord webhook endpoints.

## Send

Default target:

```json
{"action":"send","to":"discord_webhook","content":"Deployment finished."}
```

Named target:

```json
{"action":"send","to":"discord_webhook:ops","content":"Build failed on main."}
```

Long messages are split into Discord-sized webhook posts. Mentions are disabled in webhook payloads by default.

## Limits

The channel is outbound-only. It rejects reads, reactions, edits, file uploads, attachments, components, and thread APIs.

## Visibility

`hybridclaw doctor` checks Discord webhook configuration and sends a small reachability check message to each configured target. `hybridclaw gateway status` reports configured target count plus the last reachability and send result for each target.
