# Setting Up Slack

HybridClaw uses Slack Socket Mode for the Slack transport. That means the
gateway opens an outbound WebSocket to Slack instead of exposing a public
incoming webhook.

## Before You Start

You will edit:

- runtime config: `~/.hybridclaw/config.json`
- runtime secrets: `~/.hybridclaw/credentials.json`

HybridClaw needs two Slack credentials:

- `SLACK_BOT_TOKEN` (`xoxb-...`) for API calls, posting replies, uploads, and
  user lookups
- `SLACK_APP_TOKEN` (`xapp-...`) for the Socket Mode connection

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

In your Slack workspace:

1. Create a Slack app, or open the existing app you want HybridClaw to use.
2. Decide which workspace should own the bot installation.
3. Keep the app in development mode until the first successful test.

## Step 2: Enable Socket Mode

Enable Socket Mode for the app and create an app-level token with the
`connections:write` scope. Copy that token and save it as `SLACK_APP_TOKEN`.

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
- `files:write`
- `users:read`

Install or reinstall the app to the workspace after changing scopes, then copy
the bot token and save it as `SLACK_BOT_TOKEN`.

## Step 4: Subscribe To Events

Subscribe the app to the events HybridClaw listens for:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

HybridClaw ignores most bot-originated noise automatically and keeps Slack
threads mapped to stable session IDs internally.

## Step 5: Save The Credentials In HybridClaw

Recommended:

```bash
hybridclaw auth login slack --bot-token <xoxb-bot-token> --app-token <xapp-app-token>
```

If you prefer to write the values manually:

```text
/secret set SLACK_BOT_TOKEN <xoxb-bot-token>
/secret set SLACK_APP_TOKEN <xapp-app-token>
/config set slack.enabled true
```

Useful policy defaults:

```text
/config set slack.dmPolicy "allowlist"
/config set slack.groupPolicy "allowlist"
/config set slack.requireMention true
/config set slack.replyStyle "thread"
```

If you want a private first rollout, keep the default `allowlist` policies and
add only your own Slack user ID to:

- `slack.allowFrom` for DMs
- `slack.groupAllowFrom` for channels

## Step 6: Start The Gateway

```bash
hybridclaw gateway start --foreground
```

If the gateway was already running, restart it after saving the credentials or
editing `slack.*` config values.

## Step 7: Verify The Setup

1. Send the bot a DM and confirm it replies.
2. Add the bot to a channel, mention it, and confirm it replies in a thread.
3. Upload a small image or document and confirm HybridClaw can ingest the
   attachment.

If Slack is enabled but one of the tokens is missing, the gateway will keep
running and log that Slack is disabled until both credentials are present.

## Cleanup Or Reset

Use these commands to inspect or remove the setup:

```bash
hybridclaw help slack
hybridclaw auth status slack
hybridclaw auth logout slack
```
