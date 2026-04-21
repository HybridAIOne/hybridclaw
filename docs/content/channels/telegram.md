---
title: Telegram
description: BotFather setup, DM and group policy choices, and verification steps for Telegram.
sidebar_position: 5
---

# Telegram

Telegram is one of the fastest private rollout paths for HybridClaw. Start
with one BotFather token and either one allowlisted DM or an explicitly open DM
policy with groups still disabled.

For shared browser and local config surfaces, also see
[Admin Console](./admin-console.md), [Local Config And Secrets](./local-config-and-secrets.md),
and [Policies And Allowlists](./policies-and-allowlists.md).

## Step 1: Create The Bot With BotFather

1. In Telegram, open a DM with `@BotFather`.
2. Run `/newbot`.
3. Choose a display name for the bot.
4. Choose a unique username that ends in `bot`.
5. Copy the HTTP API token that BotFather returns. It looks like:

```text
123456789:AA...
```

If you already created the bot, recover the token from BotFather with
`/mybots` -> select the bot -> `API Token`.

Keep that token private. Anyone who has it can control the bot.

## Step 2: Save Telegram Config

For a private allowlisted DM setup:

```bash
hybridclaw channels telegram setup \
  --token <telegram-bot-token> \
  --allow-from <your-telegram-user-id>
```

Or explicitly open DMs while leaving groups disabled:

```bash
hybridclaw channels telegram setup \
  --token <telegram-bot-token> \
  --dm-policy open \
  --group-policy disabled
```

Notes:

- `TELEGRAM_BOT_TOKEN` is saved only when you pass `--token` or paste it
  interactively
- Telegram stays deny-by-default for inbound traffic unless you open or
  allowlist DMs and or groups
- group handling defaults to `disabled`
- `requireMention` defaults to `true` for group chats and topic threads
- allowlists accept numeric Telegram user IDs, `@username`, or `*`
- Telegram allowlists do not accept phone numbers such as `+491703330161`
- for private outbound sends, the bot can only message users who have already
  sent it at least one message; that first inbound message gives HybridClaw
  the numeric Telegram chat or user id needed for later sends
- private outbound sends still require a saved numeric Telegram chat or user
  id; arbitrary `@username` lookup is not available through the standard Bot
  API
- outbound `message` sends must use canonical Telegram ids like
  `telegram:123456789` or `telegram:-1001234567890:topic:42`; `@username`
  targets are not accepted there

The same settings can also be edited from `/admin/channels`.

Local config equivalent:

```text
/secret set TELEGRAM_BOT_TOKEN <telegram-bot-token>
/config set telegram.enabled true
/config set telegram.dmPolicy "allowlist"
/config set telegram.allowFrom ["123456789"]
/config set telegram.groupPolicy "disabled"
/config set telegram.requireMention true
```

Optional tuning:

```text
/config set telegram.pollIntervalMs 1500
/config set telegram.textChunkLimit 4000
/config set telegram.mediaMaxMb 20
```

## Allow Only One Telegram Account

If you want the bot to reply to exactly one person, the cleanest setup is:

```bash
hybridclaw channels telegram setup \
  --token <telegram-bot-token> \
  --allow-from @their_username \
  --group-policy disabled
```

If the account has no Telegram username, use the numeric Telegram user ID
instead:

```bash
hybridclaw channels telegram setup \
  --token <telegram-bot-token> \
  --allow-from 123456789 \
  --group-policy disabled
```

Equivalent local config:

```text
/config set telegram.dmPolicy "allowlist"
/config set telegram.allowFrom ["@their_username"]
/config set telegram.groupPolicy "disabled"
```

Important:

- `@username` and numeric Telegram user IDs are valid allowlist entries
- allowlisting `@username` only controls which inbound messages HybridClaw
  accepts; it does not let the bot start a private chat with that user before
  they message the bot once
- phone numbers are not valid allowlist entries for Telegram bots
- if you only know a phone number, ask that person for their Telegram username
  or numeric Telegram user ID first

## Step 3: Let The Running Gateway Reload, Or Restart It If Needed

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

If the gateway is already running and you have the admin UI open, you can also
go to `/admin/gateway` and click `Reload Gateway`.

If the gateway is already running, Telegram config changes usually hot-reload
within a few seconds. If you see a log line like:

```text
Config changed, restarting Telegram integration
Telegram integration started inside gateway
```

you can test immediately without a manual restart. If the running gateway does
not pick up the change, restart it with the commands above.

## Step 4: Verify The Setup

1. Start a DM with the bot from an allowlisted account, or use open-DM mode.
2. Send `/start` or a short message and confirm the reply lands back in
   Telegram.
3. If you enabled groups, add the bot to a group or forum topic and mention it
   first unless you disabled `requireMention`.
