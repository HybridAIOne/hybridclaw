---
title: LINE
description: Messaging API setup, webhook configuration, access policy, and verification steps for LINE.
sidebar_position: 5
---

# LINE

HybridClaw can receive signed LINE Messaging API webhooks and send text replies
back through the LINE reply and push APIs. LINE requires a public HTTPS gateway
URL for inbound messages.

For shared browser and local config surfaces, also see
[Admin Console](./admin-console.md), [Local Config And Secrets](./local-config-and-secrets.md),
and [Policies And Allowlists](./policies-and-allowlists.md).

## Step 1: Create A LINE Messaging API Channel

1. Open the [LINE Developers Console](https://developers.line.biz/console/).
2. Create or select a provider.
3. Create a Messaging API channel.
4. Copy the channel secret from **Basic settings**.
5. Issue a channel access token from **Messaging API** settings.

Keep both values private. The channel secret verifies webhook signatures, and
the channel access token can send messages as the bot.

## Step 2: Save LINE Config

For a private allowlisted DM setup:

```bash
hybridclaw channels line setup \
  --channel-access-token <line-channel-access-token> \
  --channel-secret <line-channel-secret> \
  --allow-from <your-line-user-id>
```

Or explicitly open DMs while leaving groups disabled:

```bash
hybridclaw channels line setup \
  --channel-access-token <line-channel-access-token> \
  --channel-secret <line-channel-secret> \
  --dm-policy open \
  --group-policy disabled
```

Notes:

- `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` are saved only when you
  pass them or paste them interactively
- LINE stays deny-by-default for inbound traffic unless you open or allowlist
  DMs and or groups
- group and room handling defaults to `disabled`
- `requireMention` defaults to `true` for group and room chats
- allowlists accept LINE user IDs such as `U0123...` or `*`
- LINE IDs are case-sensitive; preserve the casing from LINE
- outbound `message` sends must use canonical LINE ids like
  `line:<userId>`, `line:group:<groupId>`, or `line:room:<roomId>`
- LINE delivery is text-only in the built-in channel; local file attachments
  are not sent because LINE media messages require public HTTPS content URLs

The same settings can also be edited from `/admin/channels#line`.

Local config equivalent:

```text
/secret set LINE_CHANNEL_ACCESS_TOKEN <line-channel-access-token>
/secret set LINE_CHANNEL_SECRET <line-channel-secret>
/config set line.enabled true
/config set line.dmPolicy "allowlist"
/config set line.allowFrom ["U0123456789abcdef0123456789abcdef"]
/config set line.groupPolicy "disabled"
/config set line.requireMention true
```

Optional tuning:

```text
/config set line.webhookPath "/api/line/webhook"
/config set line.textChunkLimit 5000
```

## Step 3: Configure The LINE Webhook

Expose the gateway through your deployment URL or a trusted tunnel, then set
the LINE webhook URL to:

```text
https://your-public-gateway.example.com/api/line/webhook
```

Use the configured `line.webhookPath` if you changed it. LINE sends
`x-line-signature` with each webhook; HybridClaw verifies the signature against
the raw request body before parsing JSON.

## Step 4: Verify The Setup

1. Start or reload the gateway.
2. In LINE Developers, verify the webhook endpoint.
3. Send a DM from an allowlisted LINE account, or use open-DM mode.
4. If you enabled groups or rooms, invite the bot and mention it first unless
   you disabled `requireMention`.

Useful checks:

```bash
hybridclaw gateway status
```

If the webhook does not verify, confirm the public URL, webhook path, channel
secret, and that the deployment forwards the raw request body unchanged.
