---
title: SME Tutorials
description: Sixteen practical workflows for small business owners, marketers, sales teams, and lean software GTM teams.
sidebar_position: 1
---

# SME Tutorials

These tutorials are for small businesses that want useful automation with
HybridClaw without a full engineering project. The focus is simple: pick one
workflow, test it manually first, narrow who can talk to HybridClaw, and only
then turn on recurring delivery.

Most of these playbooks use one or more of these capabilities:

- secure HybridClaw channels on Telegram, Slack, WhatsApp, or email
- scheduled jobs through natural-language requests or `/schedule add ...`
- current web research with `web_search`
- file-grounded work from pasted notes, CSV exports, and uploaded documents
- optional office outputs such as `.docx`, `.xlsx`, `.pptx`, and PDF

Important for every scheduled workflow:

- scheduled jobs start fresh
- the prompt has to be self-contained
- include the audience, scope, tone, output format, and what to ignore

## Prompt Conventions

This section uses three prompt formats:

- `bash` blocks are terminal commands
- items under `Try it yourself` are exact prompts to paste and submit as one
  message
- items under `Conversation flow` are exact prompts too, but you send each
  numbered line as a separate message in order

Some older pages still use fenced `text` blocks for prompt templates. When a
page tells you to combine context first, build one prompt and then submit it as
one message.

## Owner Workflows

- [Morning Competitor Briefing](./morning-competitor-briefing.md)
- [Customer Feedback Digest](./customer-feedback-digest.md)

## Sales Workflows

- [Team Telegram Deal Desk](./team-telegram-deal-desk.md)
- [Forwarded Lead Triage Inbox](./forwarded-lead-triage.md)
- [WhatsApp Lead Follow-Up Copilot](./whatsapp-lead-follow-up.md)
- [Daily Pipeline Standup In Slack](./daily-pipeline-standup.md)
- [Post-Demo Follow-Up Pack](./post-demo-follow-up-pack.md)
- [Proposal Generator From Discovery Notes](./proposal-generator.md)

## Marketing Workflows

- [Campaign Pulse Digest From CSV Exports](./campaign-pulse-digest.md)
- [Weekly Content Calendar With HybridClaw](./weekly-content-calendar.md)

## Software Team GTM Workflows

- [Release Launch Kit For X, LinkedIn, And Newsletter](./release-launch-kit.md)
- [Newsletter Engine With Substack Sections And Notes](./newsletter-engine.md)
- [Founder-Led Feature Explainer Videos](./feature-explainer-videos.md)
- [Mini Feature Manual From A One-Line Brief](./mini-feature-manual.md)
- [Developer Relations Engine For GitHub And X](./devrel-engine.md)
- [Webinar Prep And Nachfassen Machine](./webinar-machine.md)

## Recommended Starting Order

If you are new to this section, the shortest path is:

1. start with [Morning Competitor Briefing](./morning-competitor-briefing.md)
2. add one messaging channel such as [Telegram](../../channels/telegram.md) or
   [Slack](../../channels/slack.md)
3. move on to one file-grounded workflow such as
   [Campaign Pulse Digest From CSV Exports](./campaign-pulse-digest.md)
4. add office outputs only when you actually need editable deliverables

## Related Pages

- [Quick Start](../../getting-started/quickstart.md)
- [Channels Overview](../../channels/overview.md)
- [Commands](../../reference/commands.md)
- [Web Search](../../reference/tools/web-search.md)
- [Optional Office Dependencies](../office-dependencies.md)
