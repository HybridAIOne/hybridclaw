---
title: Feedback Drafts
description: Let the agent queue bug and idea reports about HybridClaw for operator review.
sidebar_position: 3
---

# Feedback Drafts

The `report_feedback` tool lets an agent draft a report about HybridClaw
itself: a tool that failed, a capability that was missing, or a mistake in its
own behaviour. Drafts are queued in the gateway database. Nothing leaves the
deployment until an operator reviews the draft and sends it.

## Enable It

The tool is off by default. Turn it on per gateway:

```bash
hybridclaw config set feedback.drafts.enabled true
```

When disabled, `report_feedback` is removed from the model's tool list and the
`/api/feedback/draft` callback refuses writes.

## How A Draft Is Created

The tool description asks the model to draft only at high-signal moments: a
reproducible tool or runtime failure, a user clearly frustrated with
HybridClaw, a missing capability, or a self-observed failure such as ignoring
an instruction or stopping short. The draft carries:

- `type`: `bug`, `idea`, or `missing_capability`
- `title` and `details`, where details follow a fixed bullet order: what
  happened, what the user said (quoted verbatim or "User didn't comment"),
  repro, evidence, and an optional verified cause
- optional `area`, `trigger`, `failure_mode`, and `task_category` tags

The gateway validates the payload, redacts secrets, and enriches it with the
session id, latest turn run id, agent id, model, provider, and gateway version.
Titles are deduplicated per session, and a session holds at most 10 queued
drafts. Every draft writes a `feedback.draft.created` audit event.

After a successful call the model adds one closing line to its reply so the
user knows a draft exists and how to review it.

## Review Surfaces

When a turn queues a draft, the channel shows a review card under the reply:

- **Discord and Slack** post a card with **View**, **Send**, **Send +
  transcript**, and **Discard** buttons. Each button runs the matching
  `/feedback` command; the buttons are disabled once the draft is sent or
  discarded.
- **Web console** renders the same card inline in the chat, and the
  **Feedback drafts** admin page lists drafts across sessions with the same
  actions. The page reads `GET /api/admin/feedback-drafts?status=queued|submitted|discarded|expired|all`
  (RBAC action `admin.feedback.read`).
- **Other channels** (Teams, Telegram, Signal, email, ...) rely on the agent's
  closing line and the `/feedback` commands below.

## Host-Side Triggers

Besides the model's own judgment, the gateway adds a one-turn note to the
dynamic context when it has evidence the model may lack:

- `tool_error`: the previous turn had failed tool calls. The note names the
  tools and asks the model to consider a draft if HybridClaw was at fault and
  the failure is resolved or abandoned.
- `user_frustration`: the latest user message matches frustration patterns
  (English and German). The note asks the model to address the user first and
  to quote them verbatim if it drafts.

Notes live in the per-turn context, never in the cached system prompt, and
fire once per trigger. The `reset` confirmation also lists unsent drafts so
they are not forgotten; drafts stay reviewable by id after a reset.

## Review Commands

| Command | Effect |
| --- | --- |
| `/feedback` or `/feedback list` | List queued drafts for the current session |
| `/feedback view <id>` | Show the full draft and its metadata; marks it as reviewed |
| `/feedback send <id>` | Send the draft to HybridAI without a transcript |
| `/feedback send <id> --transcript` | Also attach the last 40 session messages and the turn trace for the draft's run |
| `/feedback discard <id>` | Drop the draft; nothing is sent |

Sending requires a signed-in HybridAI account on the gateway. The payload
records whether the draft was viewed before sending and which surface sent it.
Unsent drafts expire after 30 days. Submissions and discards write
`feedback.draft.submitted` and `feedback.draft.discarded` audit events.

## Privacy

The tool prompt forbids secrets, personal data, and names; people are referred
to by role. Titles and details pass through the secret redactor before storage,
and transcript excerpts pass through it again before sending. A transcript is
only attached when the operator asks for it with `--transcript`.
