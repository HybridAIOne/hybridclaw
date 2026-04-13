---
title: Admin Console
description: Manage channel setup, agent prompt files, and browser-based operator workflows from /admin.
sidebar_position: 10
---

# Admin Console

If the gateway is already running, open
`http://127.0.0.1:9090/admin` when you want browser-based operator workflows
instead of the CLI. The channel setup page lives at `/admin/channels`, and the
agent prompt-file editor lives at `/admin/agents`.

## What The Admin Console Can Do

- `/admin/channels` shows each transport as `active`, `configured`, or
  `available`
- `/admin/channels` edits Discord, Slack, Telegram, WhatsApp, email, Microsoft
  Teams, and iMessage settings from one place
- `/admin/channels` saves `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`,
  `SLACK_APP_TOKEN`, `TELEGRAM_BOT_TOKEN`, `EMAIL_PASSWORD`, and
  `IMESSAGE_PASSWORD` through the same encrypted runtime secret store used by
  the CLI
- `/admin/channels` shows the live WhatsApp pairing QR when the transport is
  enabled but not linked yet
- `/admin/agents` lets operators pick any registered agent and edit the
  allowlisted workspace bootstrap markdown files seeded into that agent's
  runtime workspace
- `/admin/agents` shows saved revisions for those markdown files and can
  restore an earlier version without opening the workspace directory manually

Channel edits in `/admin/channels` write the same runtime config that
`hybridclaw channels ... setup`, `hybridclaw auth login ...`, `/config set`,
and `/secret set` use.

Agent-file edits in `/admin/agents` update the selected agent's shipped
workspace bootstrap files such as `AGENTS.md`. The editor is intentionally
scoped to the built-in allowlist and is not a general workspace file browser.

## When To Prefer The Admin Console

- you want to compare transport status before editing anything
- you prefer browser forms to long CLI flag lists
- you need the WhatsApp pairing QR in a browser instead of a terminal
- you want to verify saved settings without editing `config.json` directly
- you want to update an agent's workspace instructions from the browser
- you want revision history before restoring an earlier agent prompt file
- you want to restart a running gateway from `/admin/gateway` without
  switching back to the CLI

## Related Pages

- [Overview](./overview.md)
- [Local Config And Secrets](./local-config-and-secrets.md)
- [Policies And Allowlists](./policies-and-allowlists.md)
