---
title: WhatsApp
description: Pair a WhatsApp device, manage linked auth, and choose self-chat or allowlisted DM policies.
sidebar_position: 7
---

# WhatsApp

WhatsApp is the only built-in transport that depends on an interactive QR
pairing flow. Start with self-chat or one allowlisted phone number, then widen
access only after the pairing and first reply succeed.

For shared browser and local config surfaces, also see
[Admin Console](./admin-console.md), [Local Config And Secrets](./local-config-and-secrets.md),
and [Policies And Allowlists](./policies-and-allowlists.md).

## Step 1: Make Sure No Other HybridClaw Process Owns The Auth State

Only one running process should use
`~/.hybridclaw/credentials/whatsapp` at a time. If you see stale linked-device
state or duplicate devices, reset first:

```bash
hybridclaw auth whatsapp reset
```

## Step 2: Run Setup And Pair The Device

For self-chat only:

```bash
hybridclaw channels whatsapp setup
```

For allowlisted DMs:

```bash
hybridclaw channels whatsapp setup --allow-from +14155551212
```

To force a clean re-pair and open a fresh QR session in one command:

```bash
hybridclaw channels whatsapp setup --reset --allow-from +14155551212
```

What this does:

- keeps groups disabled by default
- uses self-chat only when `--allow-from` is omitted
- switches to allowlisted DMs when one or more `--allow-from` values are
  provided
- opens a temporary QR pairing session and prints the QR code in the terminal
- disables Baileys init queries that can trigger intermittent
  `400`/`bad-request` responses during startup while keeping normal message
  delivery and pairing intact

Local TUI or web chat can update the policy after pairing, but not perform the
pairing itself:

```text
/config set whatsapp.dmPolicy "disabled"
/config set whatsapp.allowFrom []
/config set whatsapp.groupPolicy "disabled"
/config set whatsapp.groupAllowFrom []
/config set whatsapp.ackReaction ":eyes:"
```

For allowlisted DMs after pairing:

```text
/config set whatsapp.dmPolicy "allowlist"
/config set whatsapp.allowFrom ["+14155551212"]
```

The same settings can also be edited from `/admin/channels`, and that page can
show the QR flow when the transport is enabled but not paired yet.

## Step 3: Scan The QR Code

In WhatsApp, open `Settings` -> `Linked Devices` -> `Link a Device`, then scan
the QR code shown by the setup command.

## Step 4: Start Or Restart The Gateway

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

If the gateway is already running and you have the admin UI open, you can also
go to `/admin/gateway` and click `Reload Gateway`.

## Step 5: Verify The Setup

1. Send yourself a WhatsApp message if you used self-chat mode.
2. If you used `--allow-from`, send a message from one of the allowlisted
   phone numbers.
