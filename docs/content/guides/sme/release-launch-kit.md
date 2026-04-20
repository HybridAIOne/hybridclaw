---
title: "Tutorial: Release Launch Kit For X, LinkedIn, And Newsletter"
description: Turn one release brief into a full launch kit for founder posts, company posts, newsletter copy, and follow-up content.
sidebar_position: 12
---

# Tutorial: Release Launch Kit For X, LinkedIn, And Newsletter

In this tutorial, you'll turn one release into a complete launch system a
five-person software team can actually run. The goal is simple: one source of
truth in, multiple polished assets out, without every founder writing from
scratch.

## Why This Workflow Exists

The research pattern was consistent:

- strong launches use one core narrative adapted per channel, not random
  one-off posts
- founder-led posts outperform company-only posting in B2B
- teasers before launch help more than a single announcement on launch day
- small teams win by batching from one core asset, not by inventing content
  every day

## What We're Building

Here's the flow:

1. collect the release source pack from the repo
2. generate one canonical release brief
3. turn that into X posts, LinkedIn posts, a newsletter blurb, and a short
   demo script
4. schedule internal reminders so the team ships the launch in sequence

## Prerequisites

Before starting, make sure you have:

- HybridClaw running in local web chat or TUI
- a real release source, such as `CHANGELOG.md`, merged PRs, docs, or a launch
  issue
- a place to publish, such as X, LinkedIn, Substack, or your existing
  newsletter tool

## Step 1: Build The Release Source Pack

In web chat, ground the prompt with repo context:

> 🎯 **Try it yourself**
>
> ```text
> Use @diff @file:CHANGELOG.md and the relevant docs files for this release.
> 
> Create a release source pack with:
> - the core user problem solved
> - the 3 most important changes
> - who should care
> - proof points or examples
> - anything that is still rough and should not be over-claimed
> ```

If you prefer the TUI, paste the relevant files or quote the same material
manually.

## Step 2: Generate The Launch Kit

Once the release brief is accurate, ask HybridClaw for the asset bundle:

> 🎯 **Try it yourself**
>
> ```text
> Turn this release brief into a launch kit for a small developer-tool company.
> 
> Return:
> 1. Founder LinkedIn post from Founder A
> 2. Founder LinkedIn post from Founder B with a more product/engineering angle
> 3. One X thread
> 4. One short company-page post
> 5. A 120-word newsletter blurb
> 6. A 30-second feature demo script
> 7. 3 teaser lines for the 3 days before launch
> 
> Rules:
> - no hype words unless the brief supports them
> - make the user benefit obvious in the first 2 lines
> - keep the X thread punchy
> - make LinkedIn feel human, not like a press release
> ```

## Step 3: Run A Small-Team Launch Cadence

A practical cadence for `small team`:

- `T-3 days`: teaser post from one founder
- `T-1 day`: short preview or screenshot post
- `Launch day`: founder post, company post, newsletter, and demo clip
- `T+2 days`: follow-up post with a user example, customer question, or lesson

Use HybridClaw to create internal reminders:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add "0 10 * * 1-5" Remind the team to review today’s release content queue: teaser, founder posts, company post, newsletter, or follow-up asset. Keep the reminder under 8 bullets.
> ```

## Best Team Split

For your team size, this is enough:

- Founder 1: product narrative and final approval
- Founder 2: technical angle and demo walk-through
- Founder 3: outbound, comments, and follow-up conversations
- Teammate 4: assemble source pack and schedule assets
- Teammate 5: polish screenshots, thumbnails, or clips

## What To Measure

Do not measure vanity only. Start with:

- profile clicks
- replies and DMs
- trial signups or demo requests
- newsletter clicks
- direct responses from existing users

## Production Tips

- always start from the repo diff and docs, not from memory
- keep one canonical brief for the whole release
- ask for multiple founder voices, not one generic company voice

## Going Further

- [Quick Start](../../getting-started/quickstart.md)
- [Commands](../../reference/commands.md)
- [TUI MCP Quickstart](../tui-mcp.md)
