---
title: "Tutorial: Team Telegram Deal Desk"
description: Run a private Telegram group where sales reps and founders can get fast deal help, objection handling, and day-end summaries.
sidebar_position: 3
---

# Tutorial: Team Telegram Deal Desk

In this tutorial, you'll set up a private Telegram group where your team can
drop pricing questions, customer objections, rough reply drafts, and proposal
fragments. HybridClaw becomes the first-response deal desk instead of another
tab people forget to open.

## What We're Building

Here's the flow:

1. reps mention the bot in a private Telegram group
2. HybridClaw drafts replies, reframes objections, and tightens messaging
3. the bot stays concise and sales-oriented instead of generic
4. at the end of the day, it can post a short summary of open follow-ups

This is a strong fit for founder-led sales teams, small agencies, MSPs, local
service companies, and early-stage B2B startups.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- a Telegram bot token from BotFather
- a private group or forum topic for the sales team

Start with the base Telegram setup guide:

- [Telegram](../../channels/telegram.md)

For a group-first setup, a practical starting point is:

```bash
hybridclaw channels telegram setup \
  --token <telegram-bot-token> \
  --dm-policy disabled \
  --group-policy open \
  --require-mention
hybridclaw gateway restart --foreground
```

`requireMention` keeps the bot from replying to every group message.

## Step 1: Test The Deal Desk Manually

In the Telegram group, send something like:

> 🎯 **Try it yourself**
>
> ```text
> @YourBot A prospect said our onboarding sounds expensive and slow. We sell
> managed IT support for companies with 20-150 employees. Draft a reply that
> acknowledges the concern, explains our rollout in plain English, and ends with
> an invitation to book a short technical review.
> ```

Then try a pricing question:

> 🎯 **Try it yourself**
>
> ```text
> @YourBot We quoted 1800 EUR per month for 35 seats. The prospect wants a lower
> entry point. Give me 3 concession options that protect margin.
> ```

You want short, usable answers that sound like your team, not a motivational
essay.

## Step 2: Add House Rules In The Channel Setup

Open `/admin/channels` and add Telegram-specific instructions that make the bot
behave like your deal desk. A practical starting block is:

> 🎯 **Try it yourself**
>
> ```text
> You are HybridClaw acting as the internal deal desk for a small B2B sales team.
> Keep answers brief, commercial, and concrete.
> Prefer bullets over long paragraphs.
> Do not invent discounts, legal promises, or delivery dates.
> If pricing is discussed, offer options and tradeoffs instead of a single hard answer.
> If information is missing, state the gap clearly.
> ```

This matters more than people think. The channel instruction is what keeps the
bot commercially useful instead of overly helpful in the wrong direction.

## Step 3: Add A Day-End Summary

From the same Telegram group, ask:

> 🎯 **Try it yourself**
>
> ```text
> Every weekday at 5:45pm, post a short deal-desk wrap-up for this group.
> Include:
> - open customer questions mentioned today
> - quotes or proposals that still need work
> - risky deals or objection patterns
> - next actions that should happen tomorrow morning
> 
> Keep it under 12 bullets total.
> ```

Because scheduled jobs start fresh, the prompt has to state the format and the
output limits directly.

## Useful Variations

- run one group for founders and another for reps
- add a Friday summary focused only on discounts granted this week
- ask for a recurring `top objections this week` summary
- keep one pinned message in the group with your ICP, pricing floor, and red
  lines

## Production Tips

- keep the bot in private groups, not public community chats
- require mentions unless you truly want passive monitoring
- start with a few trusted users before widening access

## Going Further

- [Telegram](../../channels/telegram.md)
- [Admin Console](../../channels/admin-console.md)
- [Commands](../../reference/commands.md)
