---
title: Tutorial: Post-Demo Follow-Up Pack
description: Turn meeting notes into a same-day follow-up email, recap summary, and clear next-step list.
sidebar_position: 10
---

# Tutorial: Post-Demo Follow-Up Pack

In this tutorial, you'll compress the most fragile part of many SME sales
processes: what happens after a call. HybridClaw takes fresh meeting notes and
turns them into a same-day follow-up pack while the details still matter.

## What We're Building

Here's the flow:

1. right after a demo or discovery call, you paste rough notes
2. HybridClaw writes the customer-facing follow-up email
3. it creates an internal recap with risks, stakeholders, and next steps
4. it can remind you to follow up again if the lead goes quiet

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- notes, transcript excerpts, or bullet points from the meeting
- optional email channel setup if you want to work inside email threads

See [Email](../../channels/email.md) if you want mail-based operation.

## Step 1: Paste The Notes Fast

Do not clean them up first. Paste them while the context is fresh:

```text
Demo with Greenfield Legal.
Attendees: founder, ops manager, office admin.
Pain points:
- intake forms are manual
- follow-up reminders fall through the cracks
- partner wants simple weekly reporting

Objections:
- worried about migration effort
- wants to know if staff need training

Likely next step:
- send implementation outline and pricing options
```

## Step 2: Generate The Follow-Up Pack

Ask:

```text
Create a same-day post-demo follow-up pack.

Return:
1. a customer-facing follow-up email
2. an internal recap with:
   - main pain points
   - objections
   - buying signals
   - risks
   - next steps
3. a short checklist for what I should send next

Keep the email warm, concise, and commercially clear.
```

## Step 3: Add The Delayed Nudge

If the lead often goes quiet after the first email, add a reminder in the same
session:

```text
In 3 days, remind me to check whether Greenfield Legal replied to the demo
follow-up. If not, tell me to send a short implementation-outline follow-up.
```

This works well in TUI, web chat, Telegram, or WhatsApp if that is where you
manage your day.

## Step 4: Reuse The Pattern

Once you like the structure, save a reusable prompt with these fixed sections:

- customer-facing follow-up
- internal risk summary
- next-step checklist
- timed reminder

That turns one good workflow into a habit.

## Production Tips

- ask for one primary email and one shorter backup version
- keep the internal recap separate from the customer draft
- do the whole flow right after the meeting, not at the end of the day
- lock the internal notes within 0-2 hours and send the buyer recap the same day
- if you send more follow-up later, tie it to a concrete resource or next step

## Going Further

- [Email](../../channels/email.md)
- [Commands](../../reference/commands.md)
