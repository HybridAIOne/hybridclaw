---
title: "Tutorial: Webinar Prep And Nachfassen Machine"
description: Build a repeatable webinar system covering prep, promotion, run-of-show, follow-up, and repurposing.
sidebar_position: 16
---

# Tutorial: Webinar Prep And Nachfassen Machine

In this tutorial, you'll build a webinar system that a small software team can
run repeatedly without reinventing the playbook every time. The key idea is
simple: webinars are not just live events. They are content multipliers and
follow-up engines.

## Why This Workflow Exists

The strongest guidance from the research was:

- promotion must start well before the event
- a rehearsal and planned questions reduce live-event risk
- follow-up should be segmented, not one-size-fits-all
- the first follow-up should go out fast
- the recording should be repurposed into multiple assets

## What We're Building

Here's the flow:

1. plan the webinar with a clear audience and CTA
2. create the promo assets and reminders
3. build the live run-of-show and Q&A backup plan
4. segment the follow-up into attendees, early leavers, and no-shows
5. repurpose the recording into posts, newsletter copy, and clips

## Prerequisites

Before starting, make sure you have:

- HybridClaw running locally
- a webinar platform such as Zoom, YouTube Live, or Substack Live
- an email or newsletter tool for follow-up

## Step 1: Create The Webinar Pack

Prompt HybridClaw with the topic, audience, and desired CTA:

> 🎯 **Try it yourself**
>
> ```text
> Create a webinar prep pack for a lean software product team.
> 
> Topic: practical automation workflows for lean software teams
> Audience: technical founders and ops-minded teams
> Primary CTA: start a trial or book a deeper walkthrough
> 
> Return:
> 1. title options
> 2. positioning statement
> 3. 5 key talking points
> 4. a 30-minute run of show
> 5. 5 planted backup questions
> 6. one registration page blurb
> 7. one founder promo post
> ```

## Step 2: Build The Promotion Timeline

The Zoom best-practice pattern is still useful:

- `2+ weeks before`: confirm title, time, panelists, and start promotion
- `1 week before`: finalize slides, add polls, and run the tech rehearsal
- `day of`: final reminder, audio check, and practice session

You can turn that into internal reminders:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add "0 10 * * 1-5" Remind the team to check webinar prep status: promotion, panelist readiness, run-of-show, polls, rehearsal, and follow-up assets.
> ```

## Step 3: Prepare The Live Session

Use HybridClaw to create the live host sheet:

> 🎯 **Try it yourself**
>
> ```text
> Create a host sheet for this webinar with:
> - opening script
> - housekeeping notes
> - poll moments
> - transition lines between speakers
> - questions to use if chat is quiet
> - closing CTA
> ```

If you go live on YouTube or Substack, teasing the event in advance and using
live comments or chat intentionally is worth it.

## Step 4: Segment The Nachfassen Flow

Do not send the same email to everyone. Ask HybridClaw for three tracks:

> 🎯 **Try it yourself**
>
> ```text
> Create a post-webinar follow-up sequence for 3 segments:
> 1. attended fully
> 2. left early
> 3. registered but did not attend
> 
> For each segment, write:
> - email #1 within 24 hours
> - email #2 with a useful resource
> - email #3 with a direct CTA
> 
> Keep the voice helpful and concrete.
> ```

The webinar email guidance is clear here: segment by behavior and avoid generic
blasts.

## Step 5: Repurpose The Recording

After the event, ask HybridClaw for the asset bundle:

> 🎯 **Try it yourself**
>
> ```text
> Turn this webinar recording or transcript into:
> - one newsletter recap
> - one LinkedIn post
> - one X thread
> - 3 short clips with hook lines
> - one FAQ doc or support article
> ```

That is where the real leverage shows up.

## Best Team Split

- Founder 1: host
- Founder 2: demo or technical segment
- Founder 3: audience questions and CTA
- Teammate 4: registration page, reminders, follow-up emails
- Teammate 5: recording, clips, and repurposing

## Production Tips

- rehearse on the actual platform
- prepare backup questions before going live
- send the first follow-up within 24 hours
- repurpose immediately while the event is still fresh
- segment attendees by behavior, not just role or company

## Going Further

- [Email](../../channels/email.md)
- [Commands](../../reference/commands.md)
- [Quick Start](../../getting-started/quickstart.md)
