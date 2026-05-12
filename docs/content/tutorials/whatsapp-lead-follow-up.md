---
title: "WhatsApp Lead Follow-Up Copilot"
description: Use WhatsApp for mobile follow-up drafts, objection handling, and reminder nudges.
sidebar_position: 5
---

# WhatsApp Lead Follow-Up Copilot

In this tutorial, you'll turn WhatsApp plus HybridClaw into a mobile sales copilot for the
moments that usually happen away from your laptop: after a visit, in the car,
between meetings, or right after a call when the context is still fresh.

## What We're Building

Here's the flow:

1. you message HybridClaw in WhatsApp
2. you drop rough notes, screenshots, or a messy summary
3. HybridClaw turns that into a usable follow-up message and next-step plan
4. it can also remind you to check back in after a few days

For many owner-led sales teams, this is the highest-ROI first workflow because
it solves delay, not just formatting.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- WhatsApp paired with a dedicated device or self-chat setup

Configure the WhatsApp transport once from the
[Admin Console](../../channels/admin-console.md) at `/admin/channels`.
For a private self-chat rollout, enable the transport and complete
pairing from the QR code shown in the Admin Console — it works both
locally and in the HybridClaw cloud offering. For an allowlisted DM
rollout, add the allowed phone numbers (for example `+14155551212`) in
the WhatsApp settings before pairing. See
[WhatsApp](../../channels/whatsapp.md) for pairing details.

## Step 1: Test A Messy Real-World Prompt

Send yourself a rough note like this:

> 🎯 **Try it yourself**
>
> ```text
> Spoke to a restaurant owner. Two locations. Current POS is outdated. Biggest
> concern is downtime during migration. Budget seems tight but they are motivated
> to fix reporting before summer. Draft a follow-up WhatsApp message I can send
> today. Keep it short and confident, not pushy.
> ```

Then try an objection-handling version:

> 🎯 **Try it yourself**
>
> ```text
> The prospect said "we need to think about it". Give me 3 short follow-up
> messages:
> 1. soft check-in
> 2. value reminder
> 3. concrete next step
> ```

## Step 2: Standardize Your Prompt Pattern

When this works, keep one reusable pattern in your notes:

> 🎯 **Try it yourself**
>
> ```text
> Context:
> - what they sell
> - size of business
> - what they care about
> - what blocked the deal
> 
> Task:
> Draft one WhatsApp follow-up message and one backup version.
> Add a next-step recommendation for me only.
> Keep each message under 90 words.
> ```

Consistency beats cleverness here.

## Step 3: Add A Reminder

From the same WhatsApp chat, ask:

> 🎯 **Try it yourself**
>
> ```text
> In 2 days, remind me to follow up with the restaurant POS lead. Tell me to send
> the migration reassurance message and ask for a 15-minute technical review.
> ```

Or use an explicit command from local TUI or web chat when you want tighter
control:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add at "2026-04-22T09:00:00+02:00" Remind me to follow up with the restaurant POS lead. Tell me to send the migration reassurance message and ask for a 15-minute technical review.
> ```

## Best-Practice Notes

- **Calibrate tone to channel.** WhatsApp is a casual medium.
  Sentences that read as crisp in email read as cold on WhatsApp; copy
  lifted from LinkedIn reads as corporate. Ask for "mobile-casual, not
  meme-casual".
- **Follow-up math: 2/7/14.** For warm leads, the pattern that
  consistently wins is soft check-in within two days, value-add message
  within seven, concrete next step within fourteen. Anything slower and
  the lead goes cold; anything faster feels needy.
- **Variant fatigue is real.** Three options is a choice, ten is
  paralysis. The prompt should always cap at two to three drafts and
  label which situation each one fits.

## Production Tips

- keep this workflow private at first; self-chat is ideal
- ask for two message variants, not ten
- use it immediately after meetings while the context is still fresh
- keep each follow-up focused on one next step, not three

## Going Further

- [WhatsApp](../../channels/whatsapp.md)
- [Commands](../../reference/commands.md)
