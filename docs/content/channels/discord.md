---
title: Discord
description: Private-by-default Discord setup with restricted commands, allowlists, and guild policy tuning.
sidebar_position: 3
---

# Discord

HybridClaw starts best in Discord with a private, command-oriented setup:
allowlist one user, keep guild message handling disabled, then widen access
only after the first successful test.

For browser-based editing and shared config tooling, also see
[Admin Console](./admin-console.md), [Local Config And Secrets](./local-config-and-secrets.md),
and [Policies And Allowlists](./policies-and-allowlists.md).

## Step 1: Save Restricted Discord Config

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

If you omit `--token`, HybridClaw leaves the token unchanged and tells you
where to save `DISCORD_TOKEN` later.

The same settings can also be edited from `/admin/channels`.

Local config equivalent:

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

## Step 2: Start Or Restart The Gateway

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

If the gateway is already running and you have the admin UI open, you can also
go to `/admin/gateway` and click `Reload Gateway`.

## Step 3: Invite Or DM The Bot

1. Invite the Discord bot to your server, or open a DM with it.
2. If you want to test in a guild, use an allowlisted Discord user ID.
3. Start with DM commands if you have not allowlisted any guild user yet.

After the bot is running in Discord, you can tune guild behavior with Discord
slash commands in the channel itself:

```text
/channel-mode off
/channel-mode mention
/channel-mode free
/channel-policy open
/channel-policy allowlist
/channel-policy disabled
```
