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
| Slack | Workspace app, Socket Mode, optional native Slack slash commands | `hybridclaw auth login slack ...` | [Slack](./slack.md) |
| Telegram | Fast private DM rollout with BotFather | `hybridclaw channels telegram setup ...` | [Telegram](./telegram.md) |
| Email | Mailbox-driven workflows and threaded replies | `hybridclaw channels email setup ...` | [Email](./email.md) |
| WhatsApp | Linked-device QR pairing and phone-based DM tests | `hybridclaw channels whatsapp setup ...` | [WhatsApp](./whatsapp.md) |
| iMessage | Local Mac runtime or remote BlueBubbles relay | `hybridclaw channels imessage setup ...` | [iMessage](./imessage.md) |
| Microsoft Teams | Entra/Azure bot registration and HTTPS webhook delivery | `hybridclaw auth login msteams ...` | [Microsoft Teams](./msteams.md) |

Slack and Microsoft Teams use `auth login` because they depend on app
credentials. The other transports use `channels ... setup` because they save
channel-specific runtime config, pairing state, or a transport token directly.

## Shared Setup Surfaces

- [Admin Console](./admin-console.md) for browser-based channel setup and
  status
- [Local Config And Secrets](./local-config-and-secrets.md) for `/config` and
  `/secret` commands from local TUI and local web chat sessions
- [Policies And Allowlists](./policies-and-allowlists.md) for private-by-
  default rollout patterns and identifier formats

## Shared Inbound Media Cache

Email, Telegram, WhatsApp, and Microsoft Teams stage locally materialized
inbound attachments under one shared runtime directory:

- host path: `~/.hybridclaw/data/uploaded-media-cache/`
- container-visible path: `/uploaded-media-cache/...`

HybridClaw keeps the stored media filenames normalized, reuses the same
runtime-safe path mapping across channels, and prunes expired cached files
automatically.
