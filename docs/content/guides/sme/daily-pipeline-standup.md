---
title: Tutorial: Daily Pipeline Standup In Slack
description: Run a lightweight Slack-based sales standup with recurring prompts and concise manager summaries.
sidebar_position: 6
---

# Tutorial: Daily Pipeline Standup In Slack

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

Quick setup:

```bash
hybridclaw auth login slack --bot-token <xoxb-bot-token> --app-token <xapp-app-token>
hybridclaw gateway restart --foreground
```

See [Slack](../../channels/slack.md) for scopes and event setup.

## Step 1: Test The Standup Prompt

In your Slack channel, ask:

```text
Post a daily sales standup template for a 6-person B2B team. Keep it short.
Ask each rep for:
- top 2 active deals
- biggest blocker
- next action due today
- any deal at risk
```

Once the template looks right, ask HybridClaw to tighten the wording until the
team can answer it in under two minutes.

## Step 2: Add The Recurring Morning Prompt

From the same Slack channel, ask:

```text
Every weekday at 8:45am, post a short standup checklist for this sales channel.
Ask each rep for:
- top 2 active deals
- biggest blocker
- next action due today
- any deal at risk

Keep the message under 8 bullets total.
```

Because the job runs fresh, keep all of the structure inside the prompt.

## Step 3: Add An Afternoon Summary

Then add a second job:

```text
Every weekday at 4:45pm, summarize today's pipeline updates in this channel.
Return:
- deals likely to close soon
- deals at risk
- blockers that need founder or manager help
- tomorrow's most important follow-ups

Keep it concise and useful for a sales manager.
```

## Production Tips

- keep the channel private and focused on one team
- require simple answers from reps; long essays kill adoption
- if summaries feel generic, state your sales motion and deal size in the
  prompt
- keep the daily reply burden low enough that people actually do it

## Going Further

- [Slack](../../channels/slack.md)
- [Admin Console](../../channels/admin-console.md)
- [Commands](../../reference/commands.md)
