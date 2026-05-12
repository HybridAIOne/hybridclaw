---
title: Communication Skills
description: Discord messaging and cross-channel catch-up summaries.
sidebar_position: 4
---

# Communication Skills

## brand-voice

Draft external-facing replies in the configured brand voice before the
`brand-voice` post-receive middleware has to rewrite or block the final
message.

**Prerequisites** — optional `brand-voice` plugin configuration for enforced
rules. Without plugin config, the skill still defaults to clear neutral
business prose.

> 💡 **Tips & Tricks**
>
> Run `/brand-voice` first when the plugin is installed so the current banned
> phrases, required phrases, and mode are visible before drafting.
>
> Treat the plugin as the safety net: the highest-fidelity result is still an
> on-brand first draft.
>
> Preserve facts, links, code blocks, numbers, and citations when adjusting
> tone.

> 🎯 **Try it yourself**
>
> `Draft a customer update about the delayed launch in our brand voice`
>
> `Rewrite this sales follow-up so it stays direct, specific, and avoids hype`
>
> `Review this support reply for banned phrases before I send it`

**Troubleshooting**

- **Output gets blocked** — inspect `/brand-voice`, remove banned phrases or
  missing required language, and draft again.
- **Unexpected rewrites** — check whether the plugin is in `rewrite` mode and
  whether classifier or rewriter model credentials are configured.

---

## discord

Read, send, react to, edit, pin, and thread Discord messages using HybridClaw's
built-in `message` tool.

**Prerequisites** — HybridClaw must be connected to a Discord server
(see [Discord Channel Setup](../../channels/discord.md)).

> 💡 **Tips & Tricks**
>
> Always use explicit numeric IDs for guilds, channels, and messages.
>
> Read the channel first, then act — avoids duplicate sends and stale context.
>
> No markdown tables in Discord — they don't render. Use code blocks or lists instead.
>
> Confirm before bulk operations (mass-posting, deleting).

> 🎯 **Try it yourself**
>
> `Read the last 20 messages in #general`
>
> `Send "Deploy complete" to #deployments`
>
> `Create a thread on the last message in #bugs titled "Login issue investigation"`
>
> `Pin the announcement about the maintenance window in #ops`
>
> `Read the last 30 messages in #support, find any unanswered questions, draft replies for each, and post them as thread responses`
>
> **Conversation flow:**
>
> `1. Read the last 50 messages in #engineering and summarize the key discussions`
> `2. Create a thread on the deployment message titled "Post-deploy checklist" and post the first item: "Verify health endpoint returns 200"`
> `3. Add two more checklist items to that thread: "Confirm no error spike in monitoring" and "Update the status page"`

**Troubleshooting**

- **"Unknown channel"** — double-check the channel ID. Use guild/channel
  inspection to list available channels.
- **Message not sending** — verify bot permissions in the target channel.

---

## channel-catchup

Summarize recent activity across Discord, ingested email threads, WhatsApp, and
TUI channels.

**Prerequisites** — at least one channel connected.

> 💡 **Tips & Tricks**
>
> The skill defaults to the broadest safe scope — no need to specify every channel unless you want to narrow down.
>
> It leads with actionable updates and separates facts from significance.
>
> Default limits: Discord last 50 messages, Email last 20 threads.

> 🎯 **Try it yourself**
>
> `What happened while I was away?`
>
> `Catch me up on #engineering from the last 24 hours`
>
> `Summarize today's email threads`
>
> `Catch me up on all channels from the last 48 hours, highlight anything that needs my response, and draft reply suggestions for the urgent items`
>
> **Conversation flow:**
>
> `1. Catch me up on everything from the last 24 hours across all channels`
> `2. That incident in #ops you mentioned — show me the full timeline of messages around it`
> `3. Draft a summary of the incident and post it as a thread reply in #ops`
