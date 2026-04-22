---
title: "Founder-Led Feature Explainer Videos"
description: Plan and produce short founder-led product videos with screen walkthroughs, captions, and repurposed cut-downs.
sidebar_position: 14
---

# Founder-Led Feature Explainer Videos

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

> 🎯 **Try it yourself**
>
> ```text
> Make a video about our product.
> ```

Good brief:

> 🎯 **Try it yourself**
>
> ```text
> Make a 75-second founder-led explainer video for our product’s Telegram setup flow.
> Audience: technical founders and small teams.
> Goal: show that setup is fast and private.
> CTA: try the Telegram setup flow today.
> ```

## Step 2: Generate The Video Pack

Ask HybridClaw:

> 🎯 **Try it yourself**
>
> ```text
> Use the relevant docs and release notes to create a feature video pack.
> 
> Return:
> 1. a 75-second script
> 2. a shot list with timestamps
> 3. what the founder says on camera
> 4. what should be shown on screen
> 5. 3 hook options for the first 5 seconds
> 6. a title, thumbnail text, and YouTube description
> 7. one 20-second cut-down for X or LinkedIn
> 
> Keep the video focused on one workflow and one user benefit.
> ```

If the feature is code-heavy, ground the prompt with `@file` or `@diff`.

## Step 3: Record The Practical Version

The fastest workable format for a small team:

- 5-10 seconds founder on camera
- 45-60 seconds screen walkthrough
- 10-15 seconds CTA and next step

Do not try to sound polished. Try to sound clear.

## Step 4: Package The Video

After recording, feed the transcript or rough notes back into HybridClaw:

> 🎯 **Try it yourself**
>
> ```text
> Turn this video transcript into:
> - caption text
> - a LinkedIn post
> - an X post
> - a newsletter blurb
> - a follow-up comment I can pin under the post
> ```

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

## Best-Practice Notes

- **Hook in the first three seconds.** YouTube and LinkedIn viewer
  retention data both show the steepest drop-off happens before the 5s
  mark. The hook is the benefit, not the product name — "here's how
  the weekly invoice chase disappears" beats "today we're launching
  v2.4".
- **Repurposing math.** One good 90-second explainer yields roughly
  5–7 short vertical clips, 3 social posts, 1 newsletter section, 1
  docs page, and 1 sales-enablement clip. Plan the packaging
  alongside the shoot, not after.
- **Test thumbnails at 100x100.** YouTube thumbnails in mobile feeds
  and search sidebars are tiny. If the thumbnail is unreadable at
  100x100 pixels, rewrite it — every click you lose there is lost
  before the hook even plays.

## Production Tips

- one feature per video
- one real workflow per video
- keep the promise obvious in the first 5 seconds
- make one long version and one short cut-down from the same recording
- prefer a founder intro plus screencast over a full talking-head format
- keep the video value-led: show the outcome before the interface tour
- when you need animated insets or explanatory diagrams, the
  [Manim video and Excalidraw skills](../skills/publishing.md) can
  produce them from a short script instead of a designer handoff

## Going Further

- [Publishing Skills](../skills/publishing.md)
- [Commands](../../reference/commands.md)
