---
title: Admin Console
description: Manage channel status, settings, secrets, and browser-based setup flows from /admin/channels.
sidebar_position: 10
---

# Admin Console

If the gateway is already running, open
`http://127.0.0.1:9090/admin/channels` when you want a browser-based setup
flow instead of the CLI.

## What The Channels Page Can Do

- show each transport as `active`, `configured`, or `available`
- edit Discord, Slack, Telegram, WhatsApp, email, Microsoft Teams, and
  iMessage settings from one place
- save `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
  `TELEGRAM_BOT_TOKEN`, `EMAIL_PASSWORD`, and `IMESSAGE_PASSWORD` through the
  same encrypted runtime secret store used by the CLI
- show the live WhatsApp pairing QR when the transport is enabled but not
  linked yet

Channel edits in `/admin/channels` write the same runtime config that
`hybridclaw channels ... setup`, `hybridclaw auth login ...`, `/config set`,
and `/secret set` use.

## When To Prefer The Admin Console

- you want to compare transport status before editing anything
- you prefer browser forms to long CLI flag lists
- you need the WhatsApp pairing QR in a browser instead of a terminal
- you want to verify saved settings without editing `config.json` directly

## Related Pages

- [Overview](./overview.md)
- [Local Config And Secrets](./local-config-and-secrets.md)
- [Policies And Allowlists](./policies-and-allowlists.md)
