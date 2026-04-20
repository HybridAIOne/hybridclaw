---
title: Email
description: Configure mailbox polling, SMTP replies, allowlists, and threaded email behavior.
sidebar_position: 6
---

# Email

Email works well when HybridClaw should watch a mailbox, ingest incoming
messages, and reply into the same thread. Start with one mailbox and a narrow
sender allowlist.

For shared browser and local config surfaces, also see
[Admin Console](./admin-console.md), [Local Config And Secrets](./local-config-and-secrets.md),
and [Policies And Allowlists](./policies-and-allowlists.md).

## Step 1: Run The Setup Command

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
prompt for any missing address, IMAP or SMTP host, port, password, and
allowlist values:

```bash
hybridclaw channels email setup
```

Notes:

- `EMAIL_PASSWORD` is saved only when you pass `--password` or paste it
  interactively
- when `EMAIL_PASSWORD` is already stored, CLI setup keeps `email.password`
  pointed at that encrypted secret instead of writing the password into config
- IMAP secure mode defaults to `true`
- SMTP secure mode defaults to `false` on port `587`; use `--smtp-secure` for
  implicit TLS on port `465`
- `--no-smtp-secure` is the expected setting for STARTTLS on port `587`
- if `allowFrom` is empty, email stays outbound-only
- outbound replies preserve thread context automatically, and tool or API
  callers can pass explicit `inReplyTo` and `references` Message-ID headers
  when they need to reply into an existing external thread
- on the first successful poll with no saved cursor, HybridClaw seeds each
  folder cursor from the current mailbox head so older messages are not
  replayed as new inbound mail; later restarts still process mail that arrived
  while the gateway was offline

The same settings can also be edited from `/admin/channels`.

Local config equivalent:

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

## Step 2: Start Or Restart The Gateway

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

If the gateway is already running and you have the admin UI open, you can also
go to `/admin/gateway` and click `Reload Gateway`.

## Step 3: Verify The Setup

1. If you configured `--allow-from`, send a message from an allowlisted sender
   to the configured mailbox.
2. If you left `allowFrom` empty, treat email as outbound-only until you add
   one or more inbound senders.
