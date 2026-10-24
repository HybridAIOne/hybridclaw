# Visible follow-through

Continuing work uses the existing `/track` item as its identity. Individual
scheduled executions remain work records; action receipts remain audit evidence.
Tracking an item does not start a worker or schedule another check.

## Runtime contract

`/track list --json` retains its version 1 goal response and adds
`follow_through: {version: 1, reviews: true}`. Both mobile clients can probe this
before enabling the overview. Existing goal fields, including `done`, remain
available. Completion has one stored source: the item's `done` attribution.

- `/track overview --json` returns small summaries: `id`, `kind`, `title`,
  `revision`, `phase`, `status`, `updated_at`, `completed_at`, `completed_by`,
  `review_count`, and `next_check`.
- `/track get <id> --json` adds the existing steps, notes and immutable prepared
  results, `source_session_id`, linked `evidence`, shared `reviews`, and the latest
  50 automatically associated check-in `runs`.
- `/track update <id> <base64url-JSON> --json` applies one revision-checked change.
  It returns `{version: 1, item, applied}`. The command text is ordinary chat-safe
  JSON, using the same direct and hosted command transport as goals and schedules.

Each change includes the current integer `revision` and a unique `request_id`.
Replaying the same request returns current state with `applied: false`, without
repeating the decision. Reusing an id with different content is rejected. A stale
revision requires a fresh read and an explicit new decision. Do not automatically
retry a stale approval against a newer revision.

| Action | Additional fields | Allowed caller |
| --- | --- | --- |
| `state` | `phase`, factual `reason` (1–200 characters) | User or tool |
| `link` | `reference` | User or tool |
| `review` | `source`, `review_revision`, `decision`; `draft` for edit, `until` for defer | User command |
| `complete` | `done` boolean | User command |

For example, encode this JSON as UTF-8 base64url and send it after `update 1`:

```json
{"action":"state","phase":"waiting","reason":"Waiting for confirmation of the appointment.","revision":3,"request_id":"appointment-waiting-1"}
```

Phases are `in_progress`, `needs_you`, `waiting`, `blocked`, and the derived
`completed`. A pending review, or a deferral whose date has passed, projects as
`needs_you`. A model-written status, a completed run or a confirmed action cannot
complete a followed item. The user confirms the outcome. Pending or deferred
reviews must be resolved first. `in_progress` never claims a live worker: only a
run's `active` flag, checked against a live gateway execution, can do that.
After restart an unfinished record is inactive until an execution actually starts.

`next_check` is null unless the existing check-in task still belongs to the item,
is enabled and is manageable by the caller. Otherwise it contains the real
`task_id` and next `at` timestamp. No second timer or speculative date is stored.

## Evidence and reviews

References are structured objects:

```json
{"kind":"message","session_id":"chat-id","message_id":42}
{"kind":"work","work_id":"run-id"}
{"kind":"receipt","session_id":"chat-id","receipt_id":"run-id:tool:1"}
```

The runtime checks user, agent and session access both when linking and when
reading. A deleted or inaccessible source remains an unavailable reference; its
content and draft are withheld. Message references must identify stored assistant
messages. Receipt lookup is by exact identity, independent of the recent-receipts
window. A receipt retains its original success, failure and proof fields; linking
it is not proof that the goal's external outcome happened.

`draft_email` accepts an existing `track_id`. The tool validates access before
showing the card. Once the reply is stored, the runtime links that exact message
and creates one review. Scheduled drafts attach after delivery to the visible
chat, so a delivery retry uses the same review. A completed or removed item does
not acquire another pending review from a preparation that was already running.
Automatic association keeps the originating tracking scope; a delivered copy
never adopts an unrelated item with the same numeric id in another scope.
A draft can belong to only one tracked item. A brief can refer to that review;
it must not recreate it.

Each review has its original message `source`, exact `draft`, independent integer
`revision`, `state`, `deferred_until`, and `decided_at`. Decisions are `edit`,
`defer`, `approve`, `decline`, and `reopen`. Editing saves the complete checked
draft and increments both review and item revisions. Deferral changes when it
appears as needing attention; it sends no notification and creates no task.

**Approval here records the user's draft decision; it sends nothing and grants
no tool permission.** The consuming app must use the acknowledged draft in the
existing explicit send flow. Normal runtime action approvals still apply,
including a fresh approval if an earlier one expired. `approved` never means
`sent`. Confirmed actions appear separately as receipts. The track tool can link
receipts from later foreground turns to the same item. It cannot approve, edit
or decline a review on the user's behalf.

An approved review cannot be approved or reopened again. If a send's result is
unknown, inspect its receipt and reconcile it before proposing a new send; never
resend automatically. A replacement draft requires a new explicit review.

## Persistence and rollout

Follow-through extends `tracked.json`, using its existing synchronous gateway
mutations and atomic file replacement. Revisions advance on existing goal edits
as well. New authenticated items belong to the verified turn user; existing
items acquire that binding when follow-through is first used. No separate jobs
database or migration of phone-only decisions is introduced. Retry records keep content fingerprints rather than copies of old edited drafts.
Bounds are 100
evidence links and 1,000 remembered changes per item; reaching a bound fails
explicitly instead of forgetting retry identities.

Runtime changes precede the overview UI. iOS and Android can reuse their goal
stores, companion sheet, activity/run detail, result readers and receipt proof.
Their next PR must replace local email decisions with this acknowledged contract,
refresh after foreground return and relevant deliveries, and preserve the old
Goals/Activity/Approvals surfaces when capability metadata is absent. Never import
a local "allowed" marker as a confirmed send or replay an old approval.

The contract is tested at the runtime command and container-tool boundaries,
including scheduled delivery, restart, two-client revision conflicts and receipt
retention. Hosted relay and real connected-mail acceptance still need verification
with the consuming apps; no live mail is sent by these tests.
