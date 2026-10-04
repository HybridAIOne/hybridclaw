---
title: Background Goal Progress
description: How scheduled goals prepare useful work between check-ins.
---

# Background Goal Progress

A goal with scheduled check-ins can prepare one useful next step before writing
back. For example, a proposal goal can research options or prepare a draft in
its workspace, then include the result in the check-in for review.

Each run resolves the goal's current outcome, latest status and first unfinished
step. It does not rely on the state present when the schedule was created.
It checks earlier progress before preparing the same work again, and records
what was prepared and what still needs the user.

Preparing a draft does not send it. These runs are instructed to leave sending,
publishing, spending, booking, cancellation and changes to connected services
for the user. Existing tool permissions and approvals still apply. A step is
only completed when there is evidence its outcome was reached.

Tracking items continue to monitor and speak only when there is news. Goals
without scheduled check-ins do not acquire a background schedule.

## Proactive preferences

Each agent workspace contains `PROACTIVE_PREFERENCES.md`, editable alongside
`SOUL.md`, `MEMORY.md`, and `USER.md` in the console's agent file editor.
It is seeded when missing; existing preferences are preserved.

- **Tell me about** lists topics the agent may raise without being asked.
- **Never tell me about** excludes topics even when the agent notices them.
- **When** guides composition. The template suggests 09:00–21:30 in the user's
  local time, resolved from `USER.md`. Delivery also follows the configured
  `proactive.activeHours` guard and queue settings.
- **How** describes format and tone, adapted to the delivery channel.

The agent receives the whole current file in appended turn context. Plain
words outside the headings count too. Preference edits do not rewrite earlier
turns or the cached system prompt. If the file cannot be read in full within
the workspace context budget, the agent is instructed to stay silent for
unsolicited outreach until it can read the whole file.

Tell the agent to turn proactivity off, down, or up, or correct its topics,
timing, format, or tone in chat. It is instructed to save explicit corrections
to this file while preserving unrelated preferences. Empty topic lists are
not an invitation to send arbitrary suggestions: a message must be useful,
meaningfully new, and worth the interruption. Explicitly requested replies
and scheduled tasks still run.

These are model instructions, not a deterministic filter over message text.
Runtime approval and delivery controls still apply. Dream consolidation
continues to maintain `MEMORY.md`; proactive corrections are saved directly
to the preferences file rather than depending on a nightly pass.
