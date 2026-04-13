---
title: Policies And Allowlists
description: Private-by-default rollout patterns, policy modes, and transport-specific identifier formats.
sidebar_position: 12
---

# Policies And Allowlists

HybridClaw keeps new channel integrations private by default. The safest first
rollout is one private DM, one allowlisted sender, or one self-chat test.

## Common Policy Modes

- `disabled`: do not accept inbound traffic for that scope
- `allowlist`: accept inbound traffic only from approved identities
- `open`: accept inbound traffic from any sender in that scope

Most channels expose separate DM and group or channel policies. Start with the
smallest scope that proves the integration works.

## Recommended Rollout Pattern

1. keep groups or shared channels disabled
2. allow exactly one test sender, or use self-chat where supported
3. verify one full inbound and outbound exchange
4. widen access only after the transport works reliably

## Identifier Formats By Transport

- Discord: allowlisted user IDs and guild-specific channel policy settings
- Telegram: numeric user IDs, `@username`, or `*`; phone numbers are not valid
- Email: exact email addresses, wildcard domains like `*@example.com`, or `*`
- WhatsApp: E.164 phone numbers such as `+14155551212`
- iMessage: phone numbers, email handles, or `chat:id` entries
- Microsoft Teams: stable AAD object IDs are preferred; avoid display names
- Slack: access is mostly controlled by where the app is installed and present
  rather than a HybridClaw allowlist

## Mentions And Shared Spaces

- Discord guild behavior can stay restricted while DMs continue to work
- Telegram group handling is usually paired with `requireMention`
- WhatsApp and iMessage groups stay disabled by default
- Microsoft Teams channel messages require a mention by default
- Slack listens through Socket Mode events and app mentions in the channels
  where the app is present

Use the channel-specific pages for the exact config keys and example commands:

- [Discord](./discord.md)
- [Slack](./slack.md)
- [Telegram](./telegram.md)
- [Email](./email.md)
- [WhatsApp](./whatsapp.md)
- [iMessage](./imessage.md)
- [Microsoft Teams](./msteams.md)
