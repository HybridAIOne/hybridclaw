---
title: Local Config And Secrets
description: Use local TUI and local web chat to edit channel config and encrypted secrets directly.
sidebar_position: 11
---

# Local Config And Secrets

Local TUI and local web chat sessions can update channel runtime config and
encrypted secrets without leaving the chat surface.

## Commands

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

## Important Behavior

- these commands are only available from local TUI or local web chat sessions
- they update `~/.hybridclaw/config.json` and
  `~/.hybridclaw/credentials.json`
- `config.json` hot reload exists, and some built-in transports such as
  Telegram can restart in place when their config changes
- after startup-affecting channel changes, a gateway restart is still the
  safest fallback:
  `hybridclaw gateway restart --foreground`

## CLI-Only Gaps

No local slash-command equivalent exists today for:

- `hybridclaw channels whatsapp setup` because it opens a QR pairing session
- `hybridclaw auth whatsapp reset` because it resets linked-device auth files
- `hybridclaw auth login msteams` because it is a CLI auth flow
- `hybridclaw channels imessage setup` because it performs backend-specific CLI
  setup work and checks

For the broader auth and secret-store behavior, also see
[Authentication](../getting-started/authentication.md#named-secrets-and-secret-routes).
