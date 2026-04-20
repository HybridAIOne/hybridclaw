---
title: "Tutorial: Morning Competitor Briefing"
description: Build a weekday competitor briefing for a small business owner and deliver it to Telegram or the local inbox.
sidebar_position: 2
---

# Tutorial: Morning Competitor Briefing

In this tutorial, you'll build a daily market-watch workflow for a founder,
owner, or solo operator. HybridClaw will research a short list of competitors,
pull the most relevant updates, and deliver a compact morning briefing before
the workday starts.

## What We're Building

Here's the flow:

1. every weekday morning, the job runs automatically
2. HybridClaw searches the web for competitor activity and market signals
3. it filters for pricing, launches, partnerships, hiring, and case studies
4. it sends back a concise briefing with links and one action recommendation

This works especially well for agencies, local service companies, SaaS shops,
and niche B2B firms where a few competitors matter a lot.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and running
- web search configured; see [Web Search](../../reference/tools/web-search.md)
- a delivery surface; Telegram is ideal, but the local TUI or web chat also
  works

For Telegram delivery, set up the channel first:

```bash
hybridclaw channels telegram setup \
  --token <telegram-bot-token> \
  --allow-from <your-telegram-user-id>
hybridclaw gateway restart --foreground
```

## Step 1: Test The Briefing Manually

Open a local session:

```bash
hybridclaw tui
```

Then send a prompt like this:

> 🎯 **Try it yourself**
>
> ```text
> Search the web for the latest updates about these competitors:
> - Acme CRM
> - Northstar Digital
> - BluePeak Analytics
> 
> Focus on:
> - pricing changes
> - product launches
> - new customer stories
> - hiring or expansion signals
> - partnerships or reseller moves
> 
> Summarize the 5 most relevant updates for the owner of a small B2B business.
> For each item include:
> 1. a one-line headline
> 2. a 2-sentence summary
> 3. why it matters for me
> 4. the source link
> 
> End with a short section titled "What I should do today".
> ```

Keep iterating until the output is tight enough that you would actually read it
at 7:30 AM.

## Step 2: Create The Recurring Job

You can create the schedule in two ways.

### Option A: Ask Naturally

If you want the briefing delivered to a Telegram DM, ask from that Telegram
chat:

> 🎯 **Try it yourself**
>
> ```text
> Every weekday at 7:30am, search the web for updates about Acme CRM, Northstar
> Digital, and BluePeak Analytics. Focus on pricing changes, launches, customer
> stories, hiring signals, and partnerships. Summarize the 5 most relevant
> updates for the owner of a small B2B business. For each item include a
> headline, a 2-sentence summary, why it matters, and the source link. End with
> "What I should do today".
> ```

If you create the schedule from the same session where you want the result, the
finished briefing will be delivered back there automatically.

### Option B: Use An Explicit Schedule Command

From local TUI or web chat:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add "30 7 * * 1-5" Search the web for updates about Acme CRM, Northstar Digital, and BluePeak Analytics. Focus on pricing changes, launches, customer stories, hiring signals, and partnerships. Summarize the 5 most relevant updates for the owner of a small B2B business. For each item include a headline, a 2-sentence summary, why it matters, and the source link. End with "What I should do today".
> ```

List or remove jobs later with:

> 🎯 **Try it yourself**
>
> ```text
> /schedule list
> /schedule remove <id>
> ```

## The Rule That Matters

Scheduled jobs start fresh. Do not write:

> 🎯 **Try it yourself**
>
> ```text
> Do the usual competitor briefing.
> ```

Write the full version every time:

- which competitors
- which signals matter
- who the reader is
- how many items to return
- the output format

## Useful Variations

- change the reader to "owner of a local home-services business" if you want
  more tactical pricing and offer language
- add a country or region when your market is local
- ask for separate sections for direct competitors and adjacent market shifts
- add one final block called `Risks this week`

## Production Tips

- keep the competitor list short; three to six names is a good default
- tell HybridClaw what to ignore, such as funding fluff or generic PR
- check `hybridclaw gateway status` if a scheduled job does not fire
- include social chatter and positioning changes, not just press releases

## Going Further

- [Telegram](../../channels/telegram.md)
- [Commands](../../reference/commands.md)
- [Web Search](../../reference/tools/web-search.md)
