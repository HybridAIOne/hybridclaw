# Activity task details

Both apps open a task detail view from an Activity row. The view keeps the task
summary and time above an ordered execution history, with Open chat leading to
the original message. Each recorded thought, progress note or tool call expands
independently. Inputs and outputs are selectable plain text. Repeated calls
remain separate. The overview shows the time without the old generic tool list.

The existing runtime trace is the source of truth. It is persisted against the
assistant message, survives restarts, and is fetched only when a completed reply
is opened. While a reply runs, the detail shows current progress and Stop; its
recorded history loads after the stored message ID arrives and the reply ends.
The runtime currently has no worker identity in these traces, so the apps do not
invent subagent groups. Tool previews may be incomplete; a returned tool is not
presented as proof that the task succeeded. No extra model call generates or
rewrites execution evidence.

## Runtime integration

HybridClaw v0.36.1 adds an opt-in query to the existing, operator-bound message
endpoint:

```
GET /api/chat/message?sessionId=<session>&id=<assistant-message>&activityOffset=0
```

The response includes `id`, `sessionId`, and `activity`:

- `version: 1`, `offset`, `total`, `nextOffset` (null at the end), `elapsedMs`.
- `steps`: at most 20 items, each with an absolute `index`, `kind`, and `truncated`.
- Thinking/draft steps carry `text`. Tools carry `toolName`, `argsPreview`,
  `resultPreview`, optional `durationMs`, and the neutral status `recorded`.
- Each text field is capped at 8,000 UTF-16 units after credential redaction
  (200 for tool names).
  Clipping sets `truncated`; the app labels shortened previews. Pagination
  preserves every recorded step, including identical consecutive tool calls.

Deploy v0.36.1 or later before distributing the app change. Older runtimes return
a message without `activity`; replies without stored IDs, and replies with no
recorded trace, show an empty state.
Network/authentication failures show Retry, not an empty history. Both apps check
message/session identity, protocol version, ordering, page boundaries, field
sizes and durations. Account/persona changes invalidate in-flight responses.

## Receipt: what the reply read, sent and changed

The trace says what ran; the receipt says what came of it. The turn's `result`
line (`client: "mobile"`), `GET /api/chat/message`, and the first activity page
(`activityOffset=0`) carry `receipt`, built from the turn's tool calls and never
from the reply's words (`src/gateway/turn-receipt.ts`):

- `version: 1`, `items` (at most 30, in call order) and `more` (left out).
- Each item: `kind` (`read`, `sent` or `changed`), `tool`, `service`, `target`
  (a subject, title, page, file or search, without addresses or credentials),
  `to` (recipient domains), `count` (identical reads in a row), `ok`,
  `blocked` (the policy or the user stopped it), `error`, and `proof`.
- The approval policy's own classification (`writeIntent`, now recorded on
  `autonomy.decision`) sorts reads from changes. A call with recipients, or a
  `message` send, is `sent`. Calls waiting for approval, the agent's own cards
  and bookkeeping (`proof`, `draft_email`, `show_widget`…) are left out.
- `proof` is set for a successful send or change outside the sandbox
  (connector, `message`, browser) and follows the `/receipts` rule: a
  connector's own success counts; anything else needs a `proof` call after a
  matching check in the same turn, or it is `unconfirmed`.
- A stored reply finds its run through the `turn.end` audit row that names the
  message. A turn that read, sent and changed nothing has an empty `items`
  list, so the app can say so; replies from before the audit recorded them
  have no `receipt`.

## Access and data handling

Trace retrieval uses the existing `chat.send` permission and checks the session's
operator binding before accessing its assistant message. Other operators, user
messages, unbound sessions and missing messages return the same 404. It does not
grant broad history, audit or arbitrary file access. The normal message response
still omits trace data. The response uses `Cache-Control: no-store`.

The endpoint applies the shared credential redactor even if log redaction has
been disabled locally. Personal content stays visible to its owner. Expanded
text is never executed, treated as instructions, or automatically opened as a
link. Apps keep fetched pages in the detail view's memory, not their archives.
The gateway's existing message retention/deletion owns trace retention.

Tests cover ordering and repeated calls, pagination, malformed and oversized
pages, response identity, old-runtime responses, ownership, and forced credential
redaction. UI state and tool evidence do not assert an unrecorded success.

## Design references

The compact overview and expandable detail follow Apple's
[disclosure-control guidance](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls).
Fetching details deliberately and limiting sensitive payloads reflect the
[OpenTelemetry GenAI content guidance](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md).
These are design references; the feature does not add telemetry collection or
claim OpenTelemetry wire-format compatibility.
