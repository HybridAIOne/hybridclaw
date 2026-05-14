# Slack Incoming Webhook

`slack_webhook` is an outbound-only Slack channel for posting Block Kit messages through Slack Incoming Webhook URLs. It does not need a Slack app bot token, Socket Mode, scopes, inbound events, reactions, uploads, or threads.

Use it when an agent only needs to post status updates or alerts into a Slack channel. Use the full [Slack](./slack.md) channel when HybridClaw needs inbound chat, slash commands, approvals, file uploads, reactions, or threaded replies.

## Setup

Create an Incoming Webhook in Slack and copy the full `https://hooks.slack.com/services/...` URL. Treat the full URL as a secret.

```bash
hybridclaw channel add slack_webhook \
  --webhook-url https://hooks.slack.com/services/T00000000/B00000000/SECRET
```

This stores the webhook URL in HybridClaw encrypted runtime secrets, writes a `slackWebhook.webhooks.default.webhook_url` SecretRef into runtime config, and adds a managed network policy rule that only allows `POST` requests to Slack Incoming Webhook paths.

For multiple destinations, add named targets:

```bash
hybridclaw channel add slack_webhook \
  --target ops \
  --webhook-url https://hooks.slack.com/services/T00000000/B00000000/SECRET
```

The gateway hot-loads Slack webhook config changes. After setup, confirm status with:

```bash
hybridclaw gateway status
```

## Sending

Use the message tool with the default target:

```json
{"action":"send","to":"slack_webhook","content":"Deployment finished."}
```

Use a named target:

```json
{"action":"send","to":"slack_webhook:ops","content":"Build failed on main."}
```

HybridClaw converts message text to Slack mrkdwn, sends a `text` fallback, and emits Block Kit `section` blocks. Long text is split into section blocks of at most 3000 characters.

## Config

Runtime config uses `slackWebhook`:

```json
{
  "slackWebhook": {
    "enabled": true,
    "webhooks": {
      "default": {
        "webhook_url": { "source": "store", "id": "SLACK_WEBHOOK_URL" },
        "default_username": "HybridClaw",
        "default_icon_emoji": ":robot_face:"
      },
      "ops": {
        "webhook_url": { "source": "store", "id": "SLACK_WEBHOOK_URL_OPS" }
      }
    }
  }
}
```

The `default` target is required when `slackWebhook.enabled` is true. Invalid or missing webhook URLs fail during config load without printing the secret URL.

The admin console can enable or disable the channel, edit target display fields, and add or rotate target URLs. Saved URLs are never shown again; the console receives redacted config with blank `webhookUrl` values.

## Diagnostics

`hybridclaw doctor` checks Slack webhook configuration and sends a small reachability check message to each configured target. `hybridclaw gateway status` reports configured target count plus the last reachability and send result for each target.

## Limitations

- Outbound send only.
- No inbound Slack messages or slash commands.
- No reactions, approvals through reaction buttons, message edits, file uploads, or thread replies.
- Attachments beyond Block Kit text sections are rejected.
