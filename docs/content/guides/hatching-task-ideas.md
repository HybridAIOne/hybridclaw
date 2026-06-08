---
title: Hatching Task Ideas
description: Questions and starter job ideas for tailoring a new HybridClaw agent to a user's work, tools, and goals.
sidebar_position: 2
---

# Hatching Task Ideas

Use this guide during a new agent's first conversation and later check-ins to
suggest practical work the user may enjoy delegating to HybridClaw. Treat it as
inspiration, not a script. Match ideas to `USER.md`, the user's tools, and the
systems that are actually configured.

## Triggering Hatching

Hatching runs from `BOOTSTRAP.md` in the agent workspace. Creating an agent
seeds the workspace, but the `agent create` and `agent switch` commands are
gateway commands, not agent turns.

For automatic hatching, create the agent and then open a fresh chat/session
with that agent selected:

```text
/agent create bob
```

If you are already in a chat, switch to the new agent and then send a normal
message such as `hi`:

```text
/agent switch bob
hi
```

Do not expect hatching to run as part of the slash command response itself. The
agent needs a real turn so the bootstrapped workspace context is loaded.

## How To Use This

- Ask what the user does and which tools they live in before suggesting jobs.
- Prefer concrete recurring jobs over vague capability lists.
- Suggest a few easy first wins and one or two more ambitious workflows.
- Mention setup requirements only when relevant, such as email, calendar, CRM, GitHub, browser login, or stored credentials.
- Ask before any action that sends messages, posts publicly, changes business systems, spends money, or touches sensitive records.

## Good Hatching Follow-Ups

- "Which tools do you use every day: email, calendar, Slack, Discord, Teams, WhatsApp, Notion, Google Docs, GitHub, Trello, Stripe, HubSpot, Salesforce, accounting tools, or something else?"
- "What repeats every week that you wish someone else would prepare, summarize, check, or draft?"
- "Do you want me to be mostly a personal assistant, a business operations helper, an engineering copilot, a communications aide, or a document/media producer?"
- "Which actions should I only draft for approval instead of doing directly?"

## Personal Assistant Jobs

- Morning briefing from calendar, messages, tasks, and priority notes.
- Daily or weekly planning with focus blocks, reminders, and follow-up lists.
- Email and chat catch-up with reply drafts for important threads.
- Travel, appointment, or event prep packets with checklists and documents.
- Personal knowledge base cleanup: notes, files, contacts, links, and decisions.

## Business And Operations Jobs

- Weekly pipeline, customer, or operations digest from CRM, email, chat, and spreadsheets.
- Meeting prep packets with account context, open issues, agenda, and likely decisions.
- Post-demo follow-up packs: recap, next steps, proposal outline, and email drafts.
- Customer feedback digest from support emails, reviews, sales notes, and chat.
- Invoice and receipt collection into a normalized manifest for bookkeeping.
- KPI spreadsheet updates and executive summaries from exports or dashboards.

## Engineering Jobs

- Code review focused on bugs, regressions, security risks, and missing tests.
- GitHub issue triage, branch creation, implementation, PR drafting, and CI follow-up.
- Release prep: changelog polish, docs checks, smoke tests, and release notes.
- Architecture or feature planning with risks, milestones, and acceptance criteria.
- Incident timelines from chat logs, commits, monitoring notes, and status updates.

## Communication Jobs

- Catch-up summaries across Discord, Slack, Teams, Telegram, WhatsApp, email, and local chat.
- Draft stakeholder updates, customer replies, internal announcements, and follow-up emails.
- Convert a messy thread into decisions, action items, owners, and deadlines.
- Prepare response options for urgent messages without sending until approved.
- Keep recurring status updates short, factual, and tailored to the audience.

## Documents And Office Jobs

- Create or edit PDFs, spreadsheets, Word documents, and PowerPoint decks.
- Turn meeting notes into a polished memo, proposal, report, or slide deck.
- Build dashboards or forecasts from CSV/Excel exports.
- Produce client-ready proposal packs from templates and source materials.
- Convert findings across formats: spreadsheet analysis to memo, deck, and PDF.

## Publishing And Creative Jobs

- Draft newsletters, blog posts, launch kits, and social content calendars.
- Create diagrams for systems, workflows, onboarding, and architecture.
- Generate images or short videos for product announcements or training.
- Turn an approved script into a presentation, explainer, or avatar video plan.
- Check brand guidelines before publication.

## Tool-Specific Ideas

- **Email:** summarize threads, draft replies, collect invoices, prepare follow-ups.
- **Calendar:** find focus time, prepare meeting briefs, draft `.ics` events.
- **GitHub:** review diffs, process issues, open PRs, monitor CI.
- **Trello / project boards:** build sprint plans, risk registers, and status updates.
- **Google Workspace / docs:** search emails/docs, prepare agendas, create docs.
- **CRM / sales tools:** prep account briefs, pipeline summaries, and deal notes.
- **Stripe / billing:** inspect failed payments, customer subscriptions, and invoice workflows.
- **Discord / Slack / Teams:** catch up, summarize incidents, draft replies.
- **Apple apps:** inspect calendar, open Passwords metadata, control Music.

## Email Suggestion Template

Subject: Ways I can help with HybridClaw

Hi [Name],

Based on what you told me about [role/activity] and the tools you use, here are
a few good first jobs for me:

- [Specific job tied to their goals/tools]
- [Specific job tied to a recurring workflow]
- [Specific job that saves time quickly]
- [Specific job that needs setup or approval]

I can start with the lowest-risk one first, draft anything external for your
approval, and write down what I learn in `USER.md` so future sessions are more
useful.

[Assistant name]
