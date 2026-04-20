---
title: Tutorial: Founder-Led Feature Explainer Videos
description: Plan and produce short founder-led product videos with screen walkthroughs, captions, and repurposed cut-downs.
sidebar_position: 14
---

# Tutorial: Founder-Led Feature Explainer Videos

In this tutorial, you'll turn feature launches into short founder-led videos
that are fast to produce and easy to reuse. HybridClaw handles the planning,
script, shot list, captions, and cut-down copy. You handle the actual screen
recording and talking head.

## Why This Workflow Exists

The strongest patterns from the research were:

- good explainer videos focus on one message, not a whole product tour
- real people on camera build trust, especially founders
- screencasts are efficient for software because they are easy to update
- product demos should show value, not every button
- platform packaging matters: thumbnail, title, teaser, and cut-down versions

## What We're Building

Here's the flow:

1. choose one feature and one audience
2. ask HybridClaw for a script, shot list, and talking points
3. record a short founder intro plus a real screen walkthrough
4. use HybridClaw again for captions, title, description, teaser copy, and
   short versions

## Prerequisites

Before starting, make sure you have:

- HybridClaw running locally
- one feature worth showing
- a screen recorder such as Screen Studio, Loom, OBS, or QuickTime
- optional YouTube or LinkedIn destination

If you want animated inserts instead of only live screen footage, the docs
also ships a [Publishing Skills](../skills/publishing.md) page with the
`manim-video` workflow.

## Step 1: Define One Video, Not Ten

Bad brief:

```text
Make a video about our product.
```

Good brief:

```text
Make a 75-second founder-led explainer video for our product’s Telegram setup flow.
Audience: technical founders and small teams.
Goal: show that setup is fast and private.
CTA: try the Telegram setup flow today.
```

## Step 2: Generate The Video Pack

Ask HybridClaw:

```text
Use the relevant docs and release notes to create a feature video pack.

Return:
1. a 75-second script
2. a shot list with timestamps
3. what the founder says on camera
4. what should be shown on screen
5. 3 hook options for the first 5 seconds
6. a title, thumbnail text, and YouTube description
7. one 20-second cut-down for X or LinkedIn

Keep the video focused on one workflow and one user benefit.
```

If the feature is code-heavy, ground the prompt with `@file` or `@diff`.

## Step 3: Record The Practical Version

The fastest workable format for a small team:

- 5-10 seconds founder on camera
- 45-60 seconds screen walkthrough
- 10-15 seconds CTA and next step

Do not try to sound polished. Try to sound clear.

## Step 4: Package The Video

After recording, feed the transcript or rough notes back into HybridClaw:

```text
Turn this video transcript into:
- caption text
- a LinkedIn post
- an X post
- a newsletter blurb
- a follow-up comment I can pin under the post
```

For YouTube, Creator Academy guidance is useful here:

- custom thumbnails matter
- premieres create a shareable watch page in advance
- live chat and pinned messages help during premieres or live sessions

## Best Team Split

- Founder 1: on-camera host
- Founder 2: technical accuracy and demo environment
- Founder 3: publish and reply in comments
- Teammate 4: recording, clip selection, captions
- Teammate 5: thumbnail and scheduling

## Production Tips

- one feature per video
- one real workflow per video
- keep the promise obvious in the first 5 seconds
- make one long version and one short cut-down from the same recording
- prefer a founder intro plus screencast over a full talking-head format
- keep the video value-led: show the outcome before the interface tour

## Going Further

- [Publishing Skills](../skills/publishing.md)
- [Commands](../../reference/commands.md)
