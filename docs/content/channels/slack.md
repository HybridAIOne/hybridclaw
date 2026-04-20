---
title: Slack
description: Configure a Slack Socket Mode app, scopes, tokens, and optional native Slack slash commands.
sidebar_position: 4
---

# Slack

HybridClaw uses Slack Socket Mode for the Slack transport. That means the
gateway opens an outbound WebSocket to Slack instead of exposing a public
incoming webhook.

For shared browser and local config surfaces, also see
[Admin Console](./admin-console.md), [Local Config And Secrets](./local-config-and-secrets.md),
and [Policies And Allowlists](./policies-and-allowlists.md).

## Before You Start

You will edit:

- runtime config: `~/.hybridclaw/config.json`
- runtime secrets: `~/.hybridclaw/credentials.json`

HybridClaw needs two Slack credentials:

- `SLACK_BOT_TOKEN` (`xoxb-...`) for API calls, posting replies, uploads, and
  user lookups
- `SLACK_APP_TOKEN` (`xapp-...`) for the Socket Mode connection

The "bot" you message in Slack is the bot user attached to your own Slack app.
HybridClaw does not ship a shared Slack bot account. You create a Slack app in
your workspace, install it, and then give HybridClaw that app's bot token plus
app-level token.

## Quick Setup Commands

```bash
hybridclaw auth login slack --bot-token <xoxb-bot-token> --app-token <xapp-app-token>
hybridclaw gateway restart --foreground
```

Or run the auth command without flags and let HybridClaw prompt for both
tokens:

```bash
hybridclaw auth login slack
```

## Step 1: Create or Open the Slack App

Use the Slack developer UI, not your workspace admin/settings UI:

- open [api.slack.com/apps](https://api.slack.com/apps)
- click **Create New App**
- choose **From scratch** or **From an app manifest**
- select the Slack workspace where you want the HybridClaw bot to live

Recommended bot name examples:

- `HybridClaw Dev`
- `HybridClaw Staging`
- `HybridClaw Ops`

If you want to create the app from a manifest, this is a working starting
point:

```yaml
_metadata:
  major_version: 1
display_information:
  name: HybridClaw Dev
features:
  bot_user:
    display_name: HybridClaw Dev
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - chat:write
      - files:read
      - files:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  org_deploy_enabled: false
  socket_mode_enabled: true
  is_hosted: false
  token_rotation_enabled: false
```

If you create the app manually instead, configure the same scopes and events in
the next steps.

Keep the app in development mode until the first successful test.

## Step 2: Enable Socket Mode

In the Slack app settings:

1. Open **Socket Mode**
2. Enable Socket Mode
3. When Slack prompts for an app-level token, or from **Basic Information** ->
   **App-Level Tokens**, click **Generate Token and Scopes**
4. Add the `connections:write` scope
5. Copy the generated `xapp-...` token

Save that value as `SLACK_APP_TOKEN`.

## Step 3: Add the Bot Token Scopes

HybridClaw’s Slack runtime expects a bot token with scopes for:

- reading message events in DMs, private groups, shared multi-person DMs, and
  public channels where the app is present
- replying in threads and DMs
- uploading files
- reading user profile data for display-name resolution

A practical starting set is:

- `app_mentions:read`
- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`
- `chat:write`
- `files:read`
- `files:write`
- `users:read`

After you add or change scopes:

1. Open **OAuth & Permissions**
2. Under **Bot Token Scopes**, add the scopes above
3. Click **Install to Workspace** or **Reinstall to Workspace**
4. Copy the bot token (`xoxb-...`)

Save that value as `SLACK_BOT_TOKEN`.

## Step 4: Subscribe To Events

In **Event Subscriptions**, enable events and subscribe the app to:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

HybridClaw ignores most bot-originated noise automatically and keeps Slack
threads mapped to stable session IDs internally.

## Step 5: Enable Direct Messages In App Home

If users should be able to DM the app, Slack must allow app-user messages in
the app's App Home:

1. Open **App Home**
2. Under **Show Tabs**, enable the **Messages** tab

If this toggle is off, Slack shows an error like:

> Sending messages to this app has been turned off.

HybridClaw cannot work around that setting because Slack blocks the DM before
the event reaches the gateway.

## Optional: Native Slack Slash Commands

HybridClaw can also handle native Slack slash commands through Socket Mode.

Slack slash commands are global and not namespaced by app. Because common names
like `/status` collide with Slack's own built-in commands, HybridClaw registers
prefixed commands such as `/hc-status`.

Slack does not auto-create these from the bot token alone. You must register
the slash commands in the Slack app manifest.

Fastest path:

```bash
hybridclaw channels slack register-commands \
  --app-id <A...> \
  --config-token <xoxe-...>
```

That command:

- exports the current Slack app manifest
- adds the `commands` bot scope if needed
- registers the namespaced HybridClaw slash commands
- updates the existing app manifest in place

You can get:

- the Slack app id from the Slack app settings page
- the app configuration access token from the Slack app settings page at
  [api.slack.com/apps](https://api.slack.com/apps) under
  **Your App Configuration Tokens**

If you prefer to paste the manifest manually:

```bash
hybridclaw channels slack manifest
```

Then copy the output into the Slack app's **App Manifest** editor.

Practical rules:

- HybridClaw registers one Slack slash command per top-level HybridClaw command
  name, prefixed with `hc-`
- examples include `/hc-status`, `/hc-help`, `/hc-model`, `/hc-auth`,
  `/hc-approve`, and `/hc-channel-mode`
- trailing words are passed through as command arguments
- example: `/hc-model info` means Slack command `/hc-model` with `info` as the
  text payload

HybridClaw still accepts older unprefixed command names if you already created
them manually, and it also accepts the earlier `/hybridclaw-*` prefixed form if
you already registered that version. The recommended registration path now uses
`/hc-*` so Slack's command picker can distinguish the commands from built-in
Slack commands without being too verbose.

If Slack says the app has pending permission changes after manifest updates,
reinstall it from the Slack developer UI:

1. Open [api.slack.com/apps](https://api.slack.com/apps)
2. Select your Slack app
3. Open **OAuth & Permissions**
4. Click **Reinstall to Workspace** or **Install to Workspace**
5. Review the scopes and confirm the install

After reinstalling, reopen Slack and type `/hc-status` in the main message
composer of a DM or channel. Native Slack slash commands do not appear inside
message threads.

Native Slack slash command replies are sent as ephemeral responses, matching
Discord's private guild slash-command behavior.

## Step 6: Start Or Restart The Gateway

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

If the gateway is already running and you have the admin UI open, you can also
go to `/admin/gateway` and click `Reload Gateway`.

## Step 7: Verify The Setup

1. Open a DM with the Slack app or invite it into a test channel.
2. Send a short message or mention the app in-channel and confirm the reply.
3. If you enabled native Slack slash commands, run `/hc-status` from the main
   composer and confirm the ephemeral response.

## Step 6: Connect The App To HybridClaw

Run:

```bash
hybridclaw auth login slack --bot-token <xoxb-bot-token> --app-token <xapp-app-token>
hybridclaw auth status slack
```

Expected output from `auth status slack`:

- `Authenticated: yes`
- `Bot token: configured`
- `App token: configured`
- `Enabled: yes`

If you prefer interactive prompts:

```bash
hybridclaw auth login slack
```

## Step 7: Pick A Test-Friendly Policy

HybridClaw defaults Slack to `allowlist` mode for both DMs and channels. That
is safer for rollout, but an empty allowlist means the bot will not answer
anyone.

For an immediate smoke test, temporarily open Slack access:

```bash
hybridclaw config set slack.dmPolicy open
hybridclaw config set slack.groupPolicy open
```

For a private rollout instead, keep `allowlist` and add your own Slack user ID:

```bash
hybridclaw config set slack.allowFrom U0123456789
hybridclaw config set slack.groupAllowFrom U0123456789
```

You can leave these behavior defaults in place:

```bash
hybridclaw config set slack.requireMention true
hybridclaw config set slack.replyStyle thread
```

## Step 8: Start Or Restart The Gateway

```bash
hybridclaw gateway restart --foreground
```

If the gateway is already running and you have the admin UI open, you can also
go to `/admin/gateway` and click `Reload Gateway`.

If the gateway was already running, restart it after saving the credentials or
editing `slack.*` config values.

If you want to inspect the current runtime first:

```bash
hybridclaw gateway status
```

## Step 9: Verify The Setup

Use this exact smoke-test flow:

1. Open the Slack app's home or DM and send the bot a direct message like
   `Hallo from Slack`.
2. Invite the bot to a channel:

   ```text
   /invite @HybridClaw Dev
   ```

3. Mention it in that channel:

   ```text
   @HybridClaw Dev Hallo from channel
   ```

4. Upload a small file in the DM or channel and ask the bot to use the
   attachment.
5. Confirm the gateway sees the Slack session:

   ```bash
   hybridclaw gateway sessions
   ```

6. Optionally resume that Slack session in TUI:

   ```bash
   hybridclaw tui --resume <slack-session-id>
   ```

If Slack is enabled but one of the tokens is missing, the gateway will keep
running and log that Slack is disabled until both credentials are present.

## Troubleshooting

If Slack does not react:

1. Confirm the app is installed to the workspace and the bot is invited to the
   channel.
2. Confirm `hybridclaw auth status slack` shows:
   - `Authenticated: yes`
   - `Enabled: yes`
3. Confirm the gateway was restarted after saving the tokens:

   ```bash
   hybridclaw gateway restart --foreground
   ```

4. If `DM policy` or `Group policy` is `allowlist`, remember that empty
   allowlists mean no Slack user is allowed. For testing:

   ```bash
   hybridclaw config set slack.dmPolicy open
   hybridclaw config set slack.groupPolicy open
   hybridclaw gateway restart --foreground
   ```

5. Confirm the Slack app has all required events and scopes, especially:
   - `app_mention`
   - `message.im`
   - `chat:write`
   - `files:read`
   - `files:write`
6. Confirm **App Home** -> **Messages** tab is enabled. If it is disabled,
   Slack blocks DMs with "Sending messages to this app has been turned off."
7. If channel mentions still do nothing, test with a DM first. DMs remove the
   question of channel membership and mention handling.

## Cleanup Or Reset

Use these commands to inspect or remove the setup:

```bash
hybridclaw help slack
hybridclaw auth status slack
hybridclaw auth logout slack
```
