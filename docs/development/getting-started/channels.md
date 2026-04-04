---
title: Channel Setup
description: Step-by-step setup commands for Discord, email, WhatsApp, iMessage, and Microsoft Teams.
sidebar_position: 5
---

# Channel Setup

Use these commands to configure each transport from the CLI. HybridClaw keeps
new channel setups private by default, so most integrations need either an
allowlist, a DM, or an explicit channel policy change before they will reply to
other users.

## Command Summary

| Channel | Primary setup command |
| --- | --- |
| Discord | `hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]` |
| Email | `hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--imap-port <port>] [--imap-secure\|--no-imap-secure] [--smtp-host <host>] [--smtp-port <port>] [--smtp-secure\|--no-smtp-secure] [--folder <name>]... [--allow-from <email\|*@domain\|*>]... [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>]` |
| WhatsApp | `hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...` |
| iMessage | `hybridclaw channels imessage setup [--backend <local\|remote>] [--allow-from <phone\|email\|chat:id>]... [--server-url <url>] [--password <password>] [--cli-path <path>] [--db-path <path>] [--webhook-path <path>] [--allow-private-network]` |
| Microsoft Teams | `hybridclaw auth login msteams [--app-id <id>] [--app-password <secret>] [--tenant-id <id>]` |

Microsoft Teams uses `auth login` instead of `channels setup` because it uses
app credentials and a webhook instead of a pairing flow. Saved secrets,
defaults, and verification steps are documented in each section below.

## From The TUI Or Web Chat

Local TUI and web sessions can update runtime config and encrypted secrets with
slash commands:

```text
/config set <key> <value>
/config check
/config reload
/secret set <NAME> <value>
/secret show <NAME>
/secret unset <NAME>
/secret list
```

`/config set` accepts JSON values, including strings, numbers, booleans,
arrays, and objects. Use quoted strings for string values, for example:

```text
/config set email.address "bot@example.com"
/config set discord.commandAllowedUserIds ["123456789012345678"]
/config set email.folders ["INBOX","Support"]
/config set discord.guilds {"123456789012345678":{"defaultMode":"mention","channels":{}}}
```

Important:

- these commands are only available from local TUI or local web chat sessions
- they update `~/.hybridclaw/config.json` and `~/.hybridclaw/credentials.json`
- `config.json` hot reload exists, but channel runtimes are not fully
  reinitialized automatically today
- after startup-affecting channel changes, restart the gateway from a terminal:
  `hybridclaw gateway restart --foreground`

No slash-command equivalent exists today for:

- `hybridclaw channels whatsapp setup` because it opens a QR pairing session
- `hybridclaw auth whatsapp reset` because it resets linked-device auth files
- `hybridclaw auth login msteams` because it is a CLI auth flow
- `hybridclaw channels imessage setup` because it performs backend-specific CLI
  setup work and checks

## Discord

### Step 1: Save restricted Discord config

```bash
hybridclaw channels discord setup \
  --token <discord-bot-token> \
  --allow-user-id <your-discord-user-id>
```

What this does:

- enables command-only Discord mode
- keeps guild message handling disabled by default
- restricts guild commands to the allowlisted user IDs you pass
- saves `DISCORD_TOKEN` to `~/.hybridclaw/credentials.json` when `--token` is
  provided

If you omit `--token`, HybridClaw leaves the token unchanged and tells you where
to save `DISCORD_TOKEN` later.

TUI or web chat equivalent:

```text
/secret set DISCORD_TOKEN <discord-bot-token>
/config set discord.commandsOnly true
/config set discord.commandMode "restricted"
/config set discord.commandAllowedUserIds ["123456789012345678"]
/config set discord.commandUserId ""
/config set discord.groupPolicy "disabled"
/config set discord.freeResponseChannels []
/config set discord.guilds {}
/config set discord.prefix "!claw"
```

### Step 2: Restart the gateway

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

### Step 3: Invite or DM the bot

1. Invite the Discord bot to your server, or open a DM with it.
2. If you want to test in a guild, use an allowlisted Discord user ID.
3. Start with DM commands if you have not allowlisted any guild user yet.

After the bot is running in Discord, you can also tune Discord guild behavior
with Discord slash commands in the channel itself:

```text
/channel-mode off
/channel-mode mention
/channel-mode free
/channel-policy open
/channel-policy allowlist
/channel-policy disabled
```

## Email

### Step 1: Run the setup command

You can pass everything inline:

```bash
hybridclaw channels email setup \
  --address bot@example.com \
  --password <mail-password> \
  --imap-host imap.example.com \
  --imap-port 993 \
  --imap-secure \
  --smtp-host smtp.example.com \
  --smtp-port 587 \
  --no-smtp-secure \
  --folder INBOX \
  --allow-from you@example.com
```

Or run the command without flags in an interactive terminal and let HybridClaw
prompt for any missing address, IMAP/SMTP host, port, password, and allowlist
values:

```bash
hybridclaw channels email setup
```

Notes:

- `EMAIL_PASSWORD` is saved only when you pass `--password` or paste it
  interactively
- IMAP secure mode defaults to `true`
- SMTP secure mode defaults to `false` on port `587`; use `--smtp-secure` for
  implicit TLS on port `465`
- `--no-smtp-secure` is the expected setting for STARTTLS on port `587`
- if `allowFrom` is empty, email stays outbound-only

TUI or web chat equivalent:

```text
/secret set EMAIL_PASSWORD <mail-password>
/config set email.enabled true
/config set email.address "bot@example.com"
/config set email.imapHost "imap.example.com"
/config set email.imapPort 993
/config set email.imapSecure true
/config set email.smtpHost "smtp.example.com"
/config set email.smtpPort 587
/config set email.smtpSecure false
/config set email.folders ["INBOX"]
/config set email.allowFrom ["you@example.com"]
```

Optional tuning:

```text
/config set email.pollIntervalMs 30000
/config set email.textChunkLimit 50000
/config set email.mediaMaxMb 20
```

### Step 2: Restart the gateway

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

### Step 3: Verify the setup

1. If you configured `--allow-from`, send a message from an allowlisted sender
   to the configured mailbox.
2. If you left `allowFrom` empty, treat email as outbound-only until you add
   one or more inbound senders.

## WhatsApp

### Step 1: Make sure no other HybridClaw process owns the WhatsApp auth state

Only one running process should use
`~/.hybridclaw/credentials/whatsapp` at a time. If you see stale linked-device
state or duplicate devices, reset first:

```bash
hybridclaw auth whatsapp reset
```

### Step 2: Run setup and pair the device

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

TUI or web chat can update the policy after pairing, but not perform the
pairing itself:

```text
/config set whatsapp.dmPolicy "disabled"
/config set whatsapp.allowFrom []
/config set whatsapp.groupPolicy "disabled"
/config set whatsapp.groupAllowFrom []
/config set whatsapp.ackReaction "👀"
```

For allowlisted DMs after pairing:

```text
/config set whatsapp.dmPolicy "allowlist"
/config set whatsapp.allowFrom ["+14155551212"]
```

### Step 3: Scan the QR code

In WhatsApp, open `Settings` -> `Linked Devices` -> `Link a Device`, then scan
the QR code shown by the setup command.

### Step 4: Start or restart the gateway

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

### Step 5: Verify the setup

1. Send yourself a WhatsApp message if you used self-chat mode.
2. If you used `--allow-from`, send a message from one of the allowlisted phone
   numbers.

## iMessage

HybridClaw supports both the local macOS backend and the remote BlueBubbles
backend.

For the common local-macOS case:

```bash
hybridclaw channels imessage setup --allow-from +14155551212
hybridclaw gateway restart --foreground
```

For a remote BlueBubbles relay:

```bash
hybridclaw channels imessage setup \
  --backend remote \
  --server-url https://bluebubbles.example.com \
  --password <imessage-password> \
  --allow-from +14155551212
hybridclaw gateway restart --foreground
```

Notes:

- without `--allow-from`, inbound iMessage stays disabled and the channel is
  outbound-only
- groups stay disabled by default
- the remote backend stores `IMESSAGE_PASSWORD` only when `--password` is
  provided

TUI or web chat can write the underlying config directly.

Local backend example:

```text
/config set imessage.enabled true
/config set imessage.backend "local"
/config set imessage.cliPath "imsg"
/config set imessage.dbPath "/Users/example/Library/Messages/chat.db"
/config set imessage.dmPolicy "allowlist"
/config set imessage.groupPolicy "disabled"
/config set imessage.allowFrom ["+14155551212"]
/config set imessage.groupAllowFrom []
```

Remote BlueBubbles example:

```text
/secret set IMESSAGE_PASSWORD <imessage-password>
/config set imessage.enabled true
/config set imessage.backend "bluebubbles"
/config set imessage.serverUrl "https://bluebubbles.example.com"
/config set imessage.webhookPath "/api/imessage/webhook"
/config set imessage.allowPrivateNetwork false
/config set imessage.dmPolicy "allowlist"
/config set imessage.groupPolicy "disabled"
/config set imessage.allowFrom ["+14155551212"]
```

Use the full guide in [docs/imessage.md](../../imessage.md) for local macOS
prerequisites, BlueBubbles webhook details, and backend-specific config
examples.

## Microsoft Teams

Microsoft Teams uses an app registration and webhook instead of a pairing flow.

### Step 1: Save the Teams bot credentials

```bash
hybridclaw auth login msteams \
  --app-id <app-id> \
  --tenant-id <tenant-id> \
  --app-password <secret>
```

You can also run `hybridclaw auth login msteams` interactively and let
HybridClaw prompt for the app ID, app password, and optional tenant ID.

TUI or web chat can write the same settings manually:

```text
/secret set MSTEAMS_APP_PASSWORD <secret>
/config set msteams.enabled true
/config set msteams.appId "<app-id>"
/config set msteams.tenantId "<tenant-id>"
```

Optional policy examples:

```text
/config set msteams.dmPolicy "allowlist"
/config set msteams.groupPolicy "allowlist"
/config set msteams.allowFrom ["<your-aad-object-id>"]
```

### Step 2: Restart the gateway

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

### Step 3: Expose and register the webhook

1. Expose the gateway on public HTTPS.
2. Register the Teams messaging endpoint as
   `https://<your-public-host>/api/msteams/messages`.
3. Confirm the Microsoft Teams channel is enabled for the bot in Azure.

### Step 4: Verify the setup

1. Add your own AAD object ID to `msteams.allowFrom`, or temporarily relax the
   DM/channel policy for testing.
2. Send a DM to the bot and confirm it replies.
3. Add the bot to a Team/channel, mention it, and confirm it replies there.

Use the full guide in [docs/msteams.md](../../msteams.md) for the Azure app,
bot resource, tunnel, and webhook registration flow.
