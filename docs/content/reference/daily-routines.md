---
title: Managed daily routines
description: Runtime-owned daily schedules, edition identity, and the mobile contract.
---

# Managed daily routines

The daily brief is opt-in. Its policy lives in the bundled `daily-brief` skill;
its `routine.json` supplies the title and instructions used by the scheduler.
The apps configure one ordinary scheduled task instead of embedding prompts.
The main chat receives normal Markdown, artifacts and at most one new email draft.

`/schedule list --json` advertises `routines: {version: 1, keys: ["daily-brief"]}`.
A client must check this before sending the new subcommand. No platform API or
background phone timer is required: existing direct and hosted command transports
carry the answer as text JSON.

- Read: `/schedule routine --json daily-brief`
- Save: `/schedule routine --json daily-brief <base64url-JSON>`
- Test: `/schedule routine --json daily-brief test <revision>`
- Pause (safe to retry during consent withdrawal): `/schedule pause <id> --json`

The save payload has exactly `revision`, `enabled`, `hour` (0–23), `minute`
(0–59), `weekdays` (boolean), and `tz` (an IANA zone). On first creation,
`revision` is explicitly null. Later saves use the returned task revision.
An identical save is safe to retry after a lost acknowledgement; conflicting
changes require a fresh read. The task is the sole source of schedule settings.
A test uses saved settings and creates a separate one-shot task; it cannot consume
or replace a scheduled edition.

The read/save response contains `version: 1`, `key`, `settings`, `task` (or null),
`next_run` (or null), and `runs`. The task has a typed `managed_key`, retaining the
usual revision and history fields. Runs include `message_id` and `session_id`
(the delivery chat's session key). Link only when both are present. Display an
older successful brief with its actual date separately from a recent failure.
The apps still fetch that message through the authenticated history API.

## Timing and recovery

The selected zone stays fixed until edited. Weekdays mean Monday–Friday there.
One edition is claimed durably for each routine and local date, even across edits,
a restart or a repeated DST hour. A skipped clock time moves to the first valid
minute. A run more than five minutes late is recorded as missed; there is no
backlog generation. Pausing also retires pending delivery. Resuming waits for the next slot.

Generated output is saved before delivery. Delivery retries use this output without
another model execution, including after restart. Only today's pending output is
retried; yesterday's pending delivery is not replayed. Chat storage and the work
record's message pointer update in one transaction. Push remains best effort and
may be repeated; this is not an exactly-once notification promise. An interrupted
execution without saved output remains failed and is not silently regenerated.

The explicit brief time applies independently of proactive-check quiet hours.
Normal phone notification settings and presence handling continue to apply.
Disabling AI processing pauses this job through the existing schedule withdrawal.

## Boundaries and rollout

Identity is derived from the authenticated owner and agent, protected by a SQLite
unique index and an immediate transaction. Payloads cannot choose ownership,
instructions or delivery destinations. Scoped chats and anonymous callers cannot
configure these routines. Generic cron edits cannot replace a managed policy;
normal pause/remove and consent withdrawal remain available to its owner.
Deletion and task-id reuse cannot expose a previous owner's pending output.

Release the runtime first, then the apps. Old runtimes keep their existing schedule
UI and display an update-needed state for the daily brief. Deploying this feature
does not enable it for any account. Live model quality and a hosted deployment
smoke test require a test account; unit tests verify contract, timing, ownership,
retry and cancellation behavior without reading personal connected sources.
