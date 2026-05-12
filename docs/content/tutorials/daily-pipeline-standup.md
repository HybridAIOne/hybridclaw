---
title: "Daily Pipeline Standup In Slack"
description: Run a lightweight Slack-based sales standup with recurring prompts and concise manager summaries.
sidebar_position: 6
---

# Daily Pipeline Standup In Slack

In this tutorial, you'll build a lightweight Slack workflow for teams that need
better pipeline visibility but do not want another heavy process. HybridClaw
posts a standup prompt, the team replies with short updates, and the bot can
summarize the channel into a manager-ready snapshot.

## What We're Building

Here's the flow:

1. HybridClaw lives in a private Slack channel
2. every morning it posts a standup checklist
3. reps answer in-thread with their top deals, blockers, and next steps
4. later in the day, HybridClaw summarizes the state of the pipeline

This works well for five-person to twenty-person teams where the CRM exists but
the real story still lives in chat.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- a Slack app connected through Socket Mode
- one private channel for pipeline standups

Configure the Slack transport once from the
[Admin Console](../../channels/admin-console.md) at `/admin/channels`.
Paste the bot token (`xoxb-...`) and app token (`xapp-...`) into the Slack
fields and save. The Admin Console applies the same runtime config in
both local and cloud HybridClaw deployments. See
[Slack](../../channels/slack.md) for the required scopes and event
subscriptions.

## Step 1: Test The Standup Prompt

In your Slack channel, ask:

> 🎯 **Try it yourself**
>
> ```text
> Post a daily sales standup template for a 6-person B2B team. Keep it short.
> Ask each rep for:
> - top 2 active deals
> - biggest blocker
> - next action due today
> - any deal at risk
> ```

Once the template looks right, ask HybridClaw to tighten the wording until the
team can answer it in under two minutes.

## Step 2: Add The Recurring Morning Prompt

From the same Slack channel, ask:

> 🎯 **Try it yourself**
>
> ```text
> Every weekday at 8:45am, post a short standup checklist for this sales channel.
> Ask each rep for:
> - top 2 active deals
> - biggest blocker
> - next action due today
> - any deal at risk
> 
> Keep the message under 8 bullets total.
> ```

Because the job runs fresh, keep all of the structure inside the prompt.

## Step 3: Add An Afternoon Summary

Then add a second job:

> 🎯 **Try it yourself**
>
> ```text
> Every weekday at 4:45pm, summarize today's pipeline updates in this channel.
> Return:
> - deals likely to close soon
> - deals at risk
> - blockers that need founder or manager help
> - tomorrow's most important follow-ups
> 
> Keep it concise and useful for a sales manager.
> ```

## Best-Practice Notes

- **Deal stages lie; bottlenecks don't.** Reps say "warm" when they mean
  "waiting on their procurement team". Ask for the *specific* blocker in
  the template — the word rep says after "waiting on" is the only thing
  a manager can actually unblock.
- **Velocity > size.** Total pipeline value is vanity. Track how many
  deals moved a stage this week. A $500k stuck deal is worth less than
  three $50k deals moving through discovery.
- **Every deal has a follow-up tax.** If a rep's standup contains deals
  they haven't touched in 14 days, those deals cost attention they could
  spend on live conversations. Prune weekly.

## Production Tips

- keep the channel private and focused on one team
- require simple answers from reps; long essays kill adoption
- if summaries feel generic, state your sales motion and deal size in the
  prompt
- keep the daily reply burden low enough that people actually do it
- if your team uses [Trello](../skills/productivity.md) or
  [Notion](../skills/memory-knowledge.md) for deal tracking, ask
  HybridClaw to cross-reference the standup against the board each
  Friday so stale cards surface

## Going Further

- [Slack](../../channels/slack.md)
- [Admin Console](../../channels/admin-console.md)
- [Commands](../../reference/commands.md)
