---
title: "Weekly Content Calendar With HybridClaw"
description: Generate a practical content calendar, post ideas, and lightweight campaign briefs from business inputs you already have.
sidebar_position: 8
---

# Weekly Content Calendar With HybridClaw

In this tutorial, you'll use HybridClaw to turn product notes, offers,
customer questions, and upcoming events into a real content plan. The goal is
not "more content". The goal is a usable weekly calendar that a small team can
ship.

## What We're Building

Here's the flow:

1. you gather your current offers, launches, FAQs, and priorities
2. HybridClaw proposes a one- or two-week content calendar
3. it writes channel-specific post ideas and optional email subject lines
4. it can save the result as `.xlsx`, `.docx`, or plain Markdown

This is especially useful for businesses that know what they want to talk
about, but never turn that into a publishing rhythm.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- a rough list of offers, launches, case studies, or FAQs
- optional office tooling if you want editable files

## Step 1: Give HybridClaw Real Inputs

Paste a short working brief like this:

> 🎯 **Try it yourself**
>
> ```text
> Business: boutique accounting firm for freelancers and small agencies
> Current priorities:
> - promote quarterly tax planning calls
> - increase newsletter signups
> - move bookkeeping clients into advisory retainers
> 
> What customers ask most:
> - when should I switch from sole trader to company
> - what can I deduct
> - how do I prepare for tax season
> 
> Upcoming dates:
> - tax filing deadline reminder campaign next week
> - founder webinar in 12 days
> ```

## Step 2: Generate The Calendar

Then ask:

> 🎯 **Try it yourself**
>
> ```text
> Create a 2-week content calendar for this business.
> Return a table with:
> - date
> - channel
> - post angle
> - CTA
> - asset needed
> 
> Also include:
> - 5 email subject lines
> - 5 short LinkedIn post ideas
> - 3 FAQ-style topics that could become blog posts
> 
> Keep it practical for a 3-person team.
> ```

## Step 3: Turn It Into A Deliverable

If the plan is good, ask for a file output:

> 🎯 **Try it yourself**
>
> ```text
> Create an xlsx version of this content calendar and a short docx brief for the
> team explaining the theme for each week.
> ```

If you want to stay plain-text only, Markdown is often enough.

## Step 4: Add A Weekly Planning Habit

If you keep one short content brief in your workspace, you can reuse it every
week. A simple reminder is enough:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add "0 9 * * 1" Remind me to run the weekly content calendar planning session and update next week's offers, events, and FAQs first.
> ```

## Best-Practice Notes

- **Pillar content plus cut-downs beats daily invention.** The
  highest-leverage content model for a 3-person team is one strong
  weekly pillar (customer story, use case, walk-through) plus five or
  six short-form cut-downs from the same source. Inventing from
  scratch each day is how teams burn out and stop publishing.
- **Channel-content fit matters more than posting cadence.**
  LinkedIn rewards earned-opinion long form, X rewards punchy hooks
  and surprise, email rewards utility and specificity. The same
  sentence rewritten for each channel always beats copy-paste across
  all three.
- **Map the calendar to the buyer journey.** Awareness posts ("why
  this problem matters") need different topics from conversion posts
  ("how our solution works"). A calendar that's 90% conversion copy
  signals a team that ran out of top-of-funnel ideas — an audit worth
  doing every quarter.

## Production Tips

- give business priorities before asking for post ideas
- state the real team size and output capacity
- ask for CTAs and assets, not just captions
- build the calendar around one weekly pillar and reuse it across channels
- store the pillar list and channel-fit notes in
  [Notion or Obsidian](../skills/memory-knowledge.md) so the calendar
  prompt always reads from the same editorial source of truth

## Going Further

- [Office Skills](../skills/office.md)
- [Optional Office Dependencies](../office-dependencies.md)
