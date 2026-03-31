---
name: discord
description: Read, send, react to, edit, pin, and thread Discord messages with HybridClaw's `message` tool.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - discord
      - messaging
      - coworkers
    related_skills:
      - channel-catchup
---

# Discord Operations

Use HybridClaw's `message` tool for Discord work. This skill is for actions, not long-form catchups.

## Use Cases

- read recent channel traffic before replying
- send or edit a message in a specific channel
- react with a status emoji
- pin or unpin an important message
- create or reply inside a thread
- inspect channel or member information

## Working Rules

- Prefer explicit numeric `guildId`, `channelId`, `messageId`, and `userId` values.
- If the user gives a channel name, include `guildId` so the tool can resolve it safely.
- Read first, act second.
- Keep outbound Discord copy short and conversational.
- Do not use markdown tables in Discord messages.
- Confirm before deleting, mass-posting, or editing a message that materially changes meaning.

## Common Patterns

Read recent messages:

```json
{"action":"read","channelId":"1234567890","guildId":"9876543210","limit":20}
```

Send a message:

```json
{"action":"send","channelId":"1234567890","guildId":"9876543210","content":"Status update: the migration finished cleanly."}
```

React to a message:

```json
{"action":"react","channelId":"1234567890","guildId":"9876543210","messageId":"112233445566","emoji":"white_check_mark"}
```

Pin a message:

```json
{"action":"pin","channelId":"1234567890","guildId":"9876543210","messageId":"112233445566"}
```

Create a thread from a message:

```json
{"action":"thread-create","channelId":"1234567890","guildId":"9876543210","messageId":"112233445566","name":"Release follow-up"}
```

Reply in a thread:

```json
{"action":"thread-reply","channelId":"1234567890","guildId":"9876543210","messageId":"998877665544","content":"I checked the logs and the alert is resolved."}
```

## Decision Rules

- If the user wants a summary of channel activity, use `channel-catchup`.
- If the user wants to quote or answer a specific message, read the surrounding context first.
- If the user asks to notify a team broadly, draft the message and confirm before sending.
- For user mentions, prefer known Discord IDs over guessing display names.
