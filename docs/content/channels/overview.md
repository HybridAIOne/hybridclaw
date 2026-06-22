---
title: Overview
description: Compare the supported transports and find the primary setup path for each one.
sidebar_position: 2
---

# Overview

This is the canonical channel setup index for HybridClaw. Use it when you want
to compare transports, find the primary setup command, or jump to the
transport-specific guide.

If you are still in first-run onboarding mode, start with
[Connect Your First Channel](../getting-started/first-channel.md).

## Transport Matrix

| Channel | Good fit | Primary setup path | Canonical guide |
| --- | --- | --- | --- |
| Discord | Private bot DMs, restricted guild commands, slash commands | `hybridclaw channels discord setup ...` | [Discord](./discord.md) |
| Discord Incoming Webhook | Outbound-only Discord status updates and alerts without a bot token | `hybridclaw channel add discord_webhook ...` | [Discord Incoming Webhook](./discord-webhook.md) |
| Slack | Workspace app, Socket Mode, optional native Slack slash commands | `hybridclaw auth login slack ...` | [Slack](./slack.md) |
| Slack Incoming Webhook | Outbound-only Slack status updates and alerts without a bot token | `hybridclaw channel add slack_webhook ...` | [Slack Incoming Webhook](./slack-webhook.md) |
| Telegram | Fast private DM rollout with BotFather | `hybridclaw channels telegram setup ...` | [Telegram](./telegram.md) |
| Signal | Private Signal DMs through a signal-cli compatible daemon | `hybridclaw channels signal setup ...` | [Signal](./signal.md) |
| Threema | Outbound Gateway Basic-mode text delivery | `hybridclaw channels threema setup ...` | [Threema](./threema.md) |
| Email | Mailbox-driven workflows and threaded replies | `hybridclaw channels email setup ...` | [Email](./email.md) |
| Fax | Fax-to-email inbound PDFs and guarded outbound PDF fax delivery | `hybridclaw channels email setup ...` + `fax-send` skill | [Fax](./fax.md) |
| WhatsApp | Linked-device QR pairing and phone-based DM tests | `hybridclaw channels whatsapp setup ...` | [WhatsApp](./whatsapp.md) |
| Twilio Voice | Phone calls when you already have a public HTTPS/WSS endpoint | `/admin/channels` | [Twilio Voice](../guides/twilio-voice.md) |
| iMessage | Local Mac runtime or remote BlueBubbles relay | `hybridclaw channels imessage setup ...` | [iMessage](./imessage.md) |
| Microsoft Teams | Entra/Azure bot registration and HTTPS webhook delivery | `hybridclaw auth login msteams ...` | [Microsoft Teams](./msteams.md) |

Full Slack and Microsoft Teams use `auth login` because they depend on app
credentials. Slack Incoming Webhook and Discord Incoming Webhook are
outbound-only and use `channel add` or `channels <kind> setup` to store
encrypted webhook URLs. Most other transports use `channels ... setup` because
they save channel-specific runtime config, pairing state, or a transport token
directly. Twilio voice is currently configured from `/admin/channels` or direct
config edits because it also depends on public webhook and relay URL settings.

## Auto-Connect Conditions

On startup the gateway connects each channel that is enabled and has its
required credentials saved:

- **Discord** when `DISCORD_TOKEN` is set
- **Slack** when `slack.enabled` is true and both `SLACK_BOT_TOKEN` and
  `SLACK_APP_TOKEN` are saved
- **Slack Incoming Webhook** when `slackWebhook.enabled` is true and the default
  webhook target has a stored SecretRef
- **Telegram** when `telegram.enabled` is true and `TELEGRAM_BOT_TOKEN` is set
- **Signal** when `signal.enabled` is true and a reachable `signal-cli`
  compatible daemon plus account are configured
- **Email** when `email.enabled` is true and an email password is configured,
  typically through the stored `EMAIL_PASSWORD` secret
- **WhatsApp** when linked auth exists under
  `~/.hybridclaw/credentials/whatsapp`
- **iMessage** when `imessage.enabled` is true and either local Messages access
  or remote BlueBubbles credentials are configured
- **Microsoft Teams** when `msteams.enabled` is true and `MSTEAMS_APP_PASSWORD`
  is saved

Discord Incoming Webhook, Threema, Fax, and Twilio Voice activate from their own
setup flows; see each transport's guide in the matrix above. If a channel does
not come up, confirm it is enabled and its credentials are saved, then check
[Diagnostics](../reference/diagnostics.md).

## Shared Setup Surfaces

- [Admin Console](./admin-console.md) for browser-based channel setup and
  status
- [Local Config And Secrets](./local-config-and-secrets.md) for `/config` and
  `/secret` commands from local TUI and local web chat sessions
- [Policies And Allowlists](./policies-and-allowlists.md) for private-by-
  default rollout patterns and identifier formats

## Shared Inbound Media Cache

Email, Fax, Telegram, WhatsApp, and Microsoft Teams stage locally materialized
inbound attachments under one shared runtime directory:

- host path: `~/.hybridclaw/data/uploaded-media-cache/`
- container-visible path: `/uploaded-media-cache/...`

HybridClaw keeps the stored media filenames normalized, reuses the same
runtime-safe path mapping across channels, and prunes expired cached files
automatically.

## Delivery And Startup Behavior

- Email seeds a missing mailbox cursor from the current folder head, so the
  first successful startup does not replay older inbox history as new inbound
  traffic.
- Retry-aware transports honor service-provided `Retry-After` delays during
  transient delivery failures.
- Discord, Email, and WhatsApp treat expected transient transport outages as
  local reconnect events with rate-limited warnings instead of uncaught
  top-level failures.
- WhatsApp startup disables Baileys init queries that can trigger intermittent
  `400`/`bad-request` responses during connect.
