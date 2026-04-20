---
title: "Tutorial: Forwarded Lead Triage Inbox"
description: Turn a dedicated inbox into an internal lead triage workflow with HybridClaw for founders and sales reps.
sidebar_position: 4
---

# Tutorial: Forwarded Lead Triage Inbox

In this tutorial, you'll use HybridClaw as an internal lead triage desk. The
workflow is simple: your team forwards interesting inquiries to a dedicated
mailbox, and HybridClaw replies with a qualification summary, a risk check, and
an outbound draft.

This avoids the biggest risk in customer-facing email bots: replying directly
to strangers before you trust the workflow.

## What We're Building

Here's the flow:

1. a rep forwards a lead or inquiry email to the bot mailbox
2. HybridClaw reads the forwarded content
3. it returns a qualification snapshot, the likely buying intent, and a reply
   draft
4. your team edits and sends the final answer from the real customer mailbox

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- a dedicated email account such as `bot@example.com`
- an allowlist limited to internal senders at first

Example setup:

```bash
hybridclaw channels email setup \
  --address bot@example.com \
  --password <mail-password> \
  --imap-host imap.example.com \
  --imap-port 993 \
  --imap-secure \
  --smtp-host smtp.example.com \
  --smtp-port 587 \
  --no-smtp-secure \
  --folder INBOX \
  --allow-from founder@example.com \
  --allow-from sales@example.com
hybridclaw gateway restart --foreground
```

See [Email](../../channels/email.md) for the full setup flow.

## Step 1: Forward A Real Inquiry

Forward an actual contact-form lead, marketplace inquiry, or prospect note to
the bot mailbox with a short instruction above it, for example:

> 🎯 **Try it yourself**
>
> ```text
> Please triage this lead. Tell me:
> - hot, warm, or cold
> - what they seem to want
> - missing qualification info
> - a reply draft in a calm B2B tone
> ```

The bot will reply in-thread to the internal sender, not the prospect.

## Step 2: Standardize The Output

Once the first few replies look useful, tighten the format. Add a block like
this to your forwarded instruction:

> 🎯 **Try it yourself**
>
> ```text
> Return exactly these sections:
> 1. Lead Score
> 2. Why They Reached Out
> 3. Missing Info
> 4. Recommended Next Step
> 5. Draft Reply
> 
> Keep the whole answer under 250 words.
> ```

This is one of the easiest ways to make the workflow repeatable across a team.

## Step 3: Add Email-Specific Guardrails

In `/admin/channels`, add email channel instructions such as:

> 🎯 **Try it yourself**
>
> ```text
> You are HybridClaw acting as an internal lead-triage desk.
> Reply only to the internal sender.
> Do not claim a call is booked, a discount is approved, or a feature exists unless the email states it clearly.
> Prefer concise summaries and safe draft language.
> ```

That keeps the system useful without letting it over-commit.

## Good Inputs For This Workflow

- website contact-form forwards
- marketplace or directory inquiries
- inbound referrals
- RFP or quote requests
- old leads that reactivated after months of silence

## Production Tips

- keep the first rollout internal-only
- use a dedicated mailbox instead of your main sales inbox
- if the output gets vague, add more structure to the forwarded instruction
- keep one owner for the weekly triage flow so the mailbox does not become
  passive clutter

## Going Further

- [Email](../../channels/email.md)
- [Admin Console](../../channels/admin-console.md)
- [Commands](../../reference/commands.md)
