---
title: Connect Your First Channel
description: Pick one transport, keep it private, and verify the first successful round trip.
sidebar_position: 6
---

# Connect Your First Channel

After installation, onboarding, and provider authentication, the next step is
to connect one messaging channel and verify a real message flow end to end.

Keep the first rollout narrow:

1. choose one transport
2. keep it private with an allowlist, DM-only mode, or self-chat
3. verify one inbound message and one reply
4. widen access only after that first successful round trip

## Good First Choices

- [Slack](../channels/slack.md) when you already work in a Slack workspace and
  want app-based auth instead of QR pairing
- [Discord](../channels/discord.md) when you want slash commands, DMs, or a
  private guild test bot
- [Telegram](../channels/telegram.md) when you want a fast private DM flow
  with BotFather setup
- [Signal](../channels/signal.md) when you want private Signal DMs through a
  linked `signal-cli` companion device
- [Email](../channels/email.md) when the bot should watch a mailbox and reply
  into message threads
- [WhatsApp](../channels/whatsapp.md) when you want phone-linked testing and a
  QR pairing flow
- [Twilio Voice](../guides/twilio-voice.md) when you want phone calls and
  already have a public HTTPS/WSS tunnel or host for Twilio callbacks
- [iMessage](../channels/imessage.md) when HybridClaw runs on a Mac or can
  reach a BlueBubbles relay
- [Microsoft Teams](../channels/msteams.md) when you already have Entra/Azure
  bot infrastructure

## Pick A Transport

Use [Channels Overview](../channels/overview.md) for the full setup matrix, or
jump directly to one transport:

- [Discord](../channels/discord.md)
- [Slack](../channels/slack.md)
- [Telegram](../channels/telegram.md)
- [Signal](../channels/signal.md)
- [Email](../channels/email.md)
- [WhatsApp](../channels/whatsapp.md)
- [Twilio Voice](../guides/twilio-voice.md)
- [iMessage](../channels/imessage.md)
- [Microsoft Teams](../channels/msteams.md)

## First Verification Loop

Once you pick a transport:

1. run its setup flow and save the required credentials
2. start or restart the gateway:
   `hybridclaw gateway restart --foreground`
   If the admin UI is already open, you can also go to `/admin/gateway` and
   click `Reload Gateway`.
3. send one test message from the private scope you configured first
4. confirm HybridClaw replies through the same transport
5. if anything fails, check [Diagnostics](../reference/diagnostics.md),
   [Quick Start](./quickstart.md), and the channel-specific page

## Shared Setup Surfaces

The `Channels` section also includes the shared tools that apply across
multiple transports:

- [Admin Console](../channels/admin-console.md)
- [Local Config And Secrets](../channels/local-config-and-secrets.md)
- [Policies And Allowlists](../channels/policies-and-allowlists.md)
