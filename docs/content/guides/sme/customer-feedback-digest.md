---
title: Tutorial: Customer Feedback Digest
description: Roll customer emails, objections, and public feedback into a weekly owner digest with next actions.
sidebar_position: 11
---

# Tutorial: Customer Feedback Digest

In this tutorial, you'll build a weekly feedback digest for a founder or owner.
Instead of reacting to complaints one by one, HybridClaw rolls the week into a
single briefing: what customers praised, what they hated, what patterns are
emerging, and what deserves action now.

## What We're Building

Here's the flow:

1. you gather customer feedback from email, chats, reviews, and sales notes
2. HybridClaw groups the feedback into themes
3. it highlights severity, frequency, and likely business impact
4. it ends with concrete action recommendations for next week

This is a strong fit for service businesses, SaaS teams, agencies, and local
businesses with recurring customer contact.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- at least one real feedback source, such as email replies, review exports, or
  copied support notes
- web search configured if you also want public feedback checked on the open web

## Step 1: Assemble One Week Of Input

Good raw material:

- support emails
- lost-deal notes from sales
- customer complaints from WhatsApp or Telegram
- copied public reviews
- survey comments

Keep it rough. HybridClaw is better at synthesis when it sees the original
language.

## Step 2: Ask For The Digest

Upload or paste the material, then ask:

```text
Create a weekly customer feedback digest for the owner of a small business.
Group the feedback into themes and return:
1. what customers value most
2. repeated complaints or friction points
3. requests that could lead to upsell opportunities
4. issues that look urgent
5. 5 actions to take next week

Keep it concise and decision-oriented.
```

If you also want public signals:

```text
Also search the public web for recent reviews or public feedback about our
brand and include only relevant results with links.
```

## Step 3: Add A Weekly Reminder

If the workflow is manual, schedule the collection step:

```text
/schedule add "0 8 * * 5" Remind me to assemble this week's customer feedback emails, review notes, and sales objections before running the weekly digest.
```

That is often the missing step in small teams.

## Production Tips

- keep praise and complaints in the same digest; both matter
- ask for actions, not just summaries
- when using public web results, tell HybridClaw to include links and ignore
  low-quality directory spam
- assign one owner for the weekly digest and keep one source of truth for the
  raw inputs
- include cancel reasons or churn survey notes if you have them
- structure the output around `what changed`, `why it matters`, and `what to do
  next week`

## Going Further

- [Web Search](../../reference/tools/web-search.md)
- [Commands](../../reference/commands.md)
