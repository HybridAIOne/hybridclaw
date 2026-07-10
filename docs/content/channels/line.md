---
title: LINE
description: Link a personal LINE account by QR code and use its self-chat as a private agent channel.
---

# LINE

HybridClaw can link a personal LINE account and use messages sent from that
account to its **Keep Memo** self-chat as agent turns. Replies are written back
into Keep Memo with a `[HybridClaw]` prefix.

:::warning Unofficial personal-account integration

LINE does not provide an official API for automating a personal account.
HybridClaw uses the third-party LINEJS client and LINE's unofficial protocol.
LINE may temporarily restrict or ban an account that uses it. Use a dedicated
account and proceed only if you accept that risk. The official alternative is
a LINE Official Account with the Messaging API, which is a different account
and webhook model.

:::

## Pair the account

Stop the gateway first so only the setup process owns the auth state, then run:

```bash
hybridclaw channels line setup
```

Scan the terminal QR code with the LINE mobile app and confirm the displayed
PIN. HybridClaw stores the auth token, E2EE keys, and message sync cursor under
`~/.hybridclaw/credentials/line` with owner-only file permissions.

To discard an old session and force a fresh QR:

```bash
hybridclaw channels line setup --reset
```

You can clear the session without starting another login:

```bash
hybridclaw auth line reset
```

## Start and test

Start or restart the gateway after setup:

```bash
hybridclaw gateway restart --foreground
```

In LINE, open **Keep Memo** and send a message. Messages to contacts, groups,
and OpenChats are ignored. Outbound `message` tool sends are also rejected
unless the target is the linked account's own `line:u...` channel ID.

## Configuration

```json
{
  "line": {
    "enabled": true,
    "textChunkLimit": 5000
  }
}
```

The admin channels page shows the live QR and confirmation PIN while the
gateway is awaiting login.

## Security boundaries

- Only events where both sender and recipient equal the authenticated profile
  MID enter the agent runtime.
- Agent replies carry a `[HybridClaw]` prefix and reflected prefixed messages
  are ignored, preventing a self-reply loop.
- A process lock prevents two HybridClaw processes from writing the same LINE
  auth and E2EE state concurrently.
- Repeated QR logins are avoided by persisting the refreshed auth token and
  LINEJS storage. Repeated logins increase the risk of account restrictions.
