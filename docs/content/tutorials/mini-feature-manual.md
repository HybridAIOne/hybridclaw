---
title: "Mini Feature Manual From A One-Line Brief"
description: Turn a one-line feature note into a short user manual with verified screenshots and social-ready crops.
sidebar_position: 17
---

# Mini Feature Manual From A One-Line Brief

In this tutorial, you'll use HybridClaw to turn a tiny feature note into a
short manual that people can actually follow. The workflow is built for the
real situation most small teams have: a new feature ships, someone writes one
sentence about it, and you still need a clean mini guide with visuals before
the day is over.

## Prompt Conventions

Use the prompts on this page like this:

- anything under `Try it yourself` is one exact prompt to paste and submit
- anything under `Conversation flow` is a sequence of exact prompts; send each
  numbered line as a separate message in order
- `bash` blocks are terminal commands, not chat prompts

## Why This Workflow Exists

The outside guidance lined up well:

- task docs work best when they are narrow, skimmable, and written around one
  user goal
- screenshots should support the text, not replace it
- 2-4 key frames are usually better than a screenshot after every click
- screenshots work best when they are tightly cropped and annotated around the
  actual point of action
- a feed-friendly `4:5` crop is a strong default when you want the same
  screenshots to work in docs and on social

That is why this playbook uses one short brief, one real browser pass, and only
2-3 screenshots: entry point, action point, result.

## What We're Building

Here's the flow:

1. start with a one-line feature brief
2. have HybridClaw open the real product and find the shortest working path
3. capture 2-3 screenshots of the key states
4. crop them into reusable social-friendly images
5. ask HybridClaw to re-read the screenshots and correct the manual before
   publishing

## Prerequisites

Before starting, make sure you have:

- HybridClaw running locally in web chat or TUI
- browser access to the product you want to document
- a real feature brief, even if it is only one sentence
- a target output such as Markdown, a help-center draft, or a newsletter block

If the target product requires login in the shared browser profile, complete
the browser login from your normal HybridClaw chat session first — just ask
"log in to the shared browser" and HybridClaw will open the browser and walk
you through it. This works the same way in local installs and in the
HybridClaw cloud offering. You can also paste screenshots back into chat
later if you want a second review pass from image attachments.

## Step 1: Start With The Smallest Useful Brief

Do not wait for a polished spec. Start with the short internal note you
actually have.

For this workflow, a one-line feature note plus audience and output constraints
is enough to begin.

> 🎯 **Try it yourself**
>
> `Use this feature brief: "You can now use /status in the HybridClaw /chat website." Audience: existing users of the HybridClaw /chat website. Goal: help someone use the feature for the first time in under 2 minutes. Output: a mini manual with 3-5 steps, 2-3 screenshots, and one short FAQ. First, restate the user job in one sentence and tell me what might still be ambiguous before we capture anything.`

## Step 2: Make HybridClaw Find The Real Flow

The first pass should be grounded in the live UI, not just the sentence above.
Submit this as a new prompt after Step 1:

> 🎯 **Try it yourself**
>
> `Use this feature brief: "You can now use /status in the HybridClaw /chat website." Open the real HybridClaw /chat flow and find the shortest accurate path a user needs to follow. Return the actual steps needed, anything in the brief that is vague or potentially wrong, and the 2-3 UI states that are worth capturing as screenshots. Optimize for first-time users, skip obvious micro-steps, do not invent labels, buttons, or states, and if the interface differs from the brief, trust the interface and flag the mismatch.`

This follows the GitHub Docs and GitLab pattern: only use screenshots when the
UI is hard to find, visually dense, or easy to misread in text alone.

## Step 3: Capture Only The Key Frames

Once HybridClaw has the real flow, submit this as a new prompt:

> 🎯 **Try it yourself**
>
> `Capture 3 screenshots for this mini manual: where the user starts, the exact action point for /status, and the result or status view the user should expect. For each screenshot, crop to the relevant working area instead of the whole screen, keep enough surrounding UI for orientation, add a simple callout only if the click target is easy to miss, and avoid private data, account details, or unrelated sidebars.`

Good screenshot discipline matters here. The Reddit and Archbee patterns are
useful: one screenshot per section, show the direct object the user needs, and
do not capture more UI than necessary.

## Step 4: Ask For Social-Ready Crops

If the same manual will also be reused in a changelog, newsletter, or social
post, submit this as a new prompt:

> 🎯 **Try it yourself**
>
> `For each approved screenshot, create a documentation image, a 4:5 social crop at 1080x1350 for feed reuse, and one 1200x630 preview image for link previews or newsletter social cards.`

`4:5` is a strong default for feed posts because it takes up more mobile screen
space, while `1200x630` works well for social preview cards and Substack-style
sharing surfaces. If the same feature will also become a YouTube explainer,
create a separate `16:9` thumbnail image instead of reusing the `4:5` crop.

## Step 5: Force A Screenshot Verification Pass

This is the step that makes the workflow valuable instead of merely fast.

Do not publish the first draft from the brief alone. Submit this as a new
prompt so HybridClaw reads the captured screenshots and reconciles the copy
against them:

> 🎯 **Try it yourself**
>
> `Read the screenshots you just captured as the source of truth. Now write the final mini manual with a title, one-sentence summary, prerequisites if needed, 3-5 numbered steps, one expected result section, one short FAQ, and alt text for each screenshot. If the screenshots show different labels or ordering than the earlier draft, fix the text. Keep the whole manual short enough to fit on one screen before the images, use direct language, and write for someone who already knows the product but not this feature.`

That final reconciliation pass catches the common failure mode where the copy
describes the intended feature while the screenshots show the actual UI.

## Conversation Flow

If you want the shortest possible working sequence, send these four prompts as
separate messages in order:

> 🎯 **Conversation flow**
>
> `1. Use this feature brief: "You can now use /status in the HybridClaw /chat website." Open the real HybridClaw /chat flow and find the shortest accurate path a user needs to follow. Return the actual steps needed, anything in the brief that is vague or potentially wrong, and the 2-3 UI states that are worth capturing as screenshots. Optimize for first-time users, skip obvious micro-steps, do not invent labels, buttons, or states, and if the interface differs from the brief, trust the interface and flag the mismatch.`
>
> `2. Capture 3 screenshots for this mini manual: where the user starts, the exact action point for /status, and the result or status view the user should expect. For each screenshot, crop to the relevant working area instead of the whole screen, keep enough surrounding UI for orientation, add a simple callout only if the click target is easy to miss, and avoid private data, account details, or unrelated sidebars.`
>
> `3. For each approved screenshot, create a documentation image, a 4:5 social crop at 1080x1350 for feed reuse, and one 1200x630 preview image for link previews or newsletter social cards.`
>
> `4. Read the screenshots you just captured as the source of truth. Now write the final mini manual with a title, one-sentence summary, prerequisites if needed, 3-5 numbered steps, one expected result section, one short FAQ, and alt text for each screenshot. If the screenshots show different labels or ordering than the earlier draft, fix the text. Keep the whole manual short enough to fit on one screen before the images, use direct language, and write for someone who already knows the product but not this feature.`

## Suggested Output Pack

For a lean release workflow, ask for this bundle:

- one Markdown mini manual
- three PNG screenshots for docs
- three `4:5` crops for social reuse
- one `1200x630` preview image
- one short post or changelog blurb linking back to the manual

## Best-Practice Notes

- **Progressive disclosure beats exhaustive coverage.** Technical
  writing research is consistent: readers skim first, read second.
  Put the one happy path in the numbered steps and push every edge
  case, error state, and "what if I'm on the old plan" detail into
  a collapsible FAQ at the bottom. A manual that lists 12 steps
  because three of them are conditional teaches readers to stop
  reading manuals.
- **Alt text is not optional metadata.** Descriptive alt text on each
  screenshot is the accessibility floor (screen readers), the SEO
  ceiling (image search), and the fallback surface when images fail
  to load in email clients or feed readers. "Screenshot of /status
  response showing gateway online" beats "screenshot1.png" on every
  axis that matters.
- **Date the manual when the UI is still moving.** If the feature
  shipped this week, add a visible "Last verified: 2026-04-22" line
  under the title. It sets reader expectations, flags the page for
  reviewers when the UI changes, and is far cheaper than discovering
  six months later that your top-ranking help article shows a button
  that no longer exists.

## Production Tips

- start from the real user action, not from internal feature wording
- keep the manual to one task only
- use 2-3 screenshots unless the screen changes materially
- blur or avoid anything sensitive before you publish
- ask for alt text and file names so the asset pack is ready to drop into docs
- if the UI is still shifting, keep the manual short and easy to refresh
- use the [Publishing Skills](../skills/publishing.md) to convert the
  Markdown manual into a polished WordPress help-center post, or the
  [Office Skills](../skills/office.md) to export a printable `.docx`
  version for internal onboarding decks

## Going Further

- [Quick Start](../../getting-started/quickstart.md)
- [Commands](../../reference/commands.md)
- [FAQ](../../reference/faq.md)
- [Release Launch Kit For X, LinkedIn, And Newsletter](./release-launch-kit.md)
