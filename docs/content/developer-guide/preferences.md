---
title: Shared preferences
description: Durable explicit preferences and feedback across companion apps, chat and scheduled generation.
---

# Shared preferences

The runtime keeps one preference record per authenticated user. Both Hy apps
send explicit likes, hidden stories, dismissed Ideas and the feed brief to it.
Chat and story discussions use the `preferences` tool to retain what the user
actually says they want. Opening, reading, bookmarking, or merely beginning a
discussion never creates a taste signal.

The gateway injects this record into foreground conversation context and into
scheduled generation using the task's verified owner. Web chat Ideas use the
same record. Each run reads current state; changing a preference does not
require replacing a schedule or keeping a phone open. The model interprets the
explicit signals when selecting content; this is not a separate learned-model
or transcript-summarization service.

## App transport

`/preferences sync <base64url-json-array> --json` accepts up to 100 events and
returns `{ "version": 1, "acknowledged": ["event-id"] }`. Unpadded base64url
preserves Unicode, line breaks and quotes through chat relays. Each event has:

- `id`: a stable retry identifier, up to 80 ASCII letters, digits or hyphens.
- `key`: the item being changed, at most 240 characters (`feed:<post-id>`,
  `idea:<title>`, or `feed-brief`).
- `kind`: `like`, `hide`, `neutral`, `dismiss`, `instruction`, or `brief`.
- `text`: the title or preference text, at most 2,000 UTF-16 code units.
- `at`: integer Unix milliseconds when the explicit action occurred. Timestamps
  more than five minutes in the future are rejected.

Events merge by key and occurrence time, with ID as a deterministic tie-breaker.
`neutral` is a tombstone, so a retained unlike cannot be undone by an older
retry. There are at most 1,000 feedback records plus 30 explicit preferences;
reactions cannot evict the active brief or an explicit instruction. Prompt
context includes all explicit preferences, up to 200 dismissals and the 60
most recent likes/hides; the tool can read the complete retained record.
A new explicit key beyond the limit is rejected, so Hy must revise or clear
an existing preference. This bounded history does not preserve reactions
forever. Device clocks should be synchronized.

`/preferences show --json` returns the retained events for the caller.
The command's authenticated identity is authoritative; no user ID in the
payload is accepted. Storage is atomic, mode 0600, in the runtime data folder
under `preferences/<SHA-256 of user ID>.json`. Corrupt records fail rather than
being silently replaced.

## Chat tool

`preferences` uses `get`, or `set` with a stable `key`, `text`, and optional
`kind` (`instruction`, `brief`, `neutral`). A request such as “less crypto,
more cycling” is saved as an explicit preference. To revise the brief, use
`kind=brief` and `key=feed-brief` with the complete revised brief, at most
1,000 characters like the apps' brief editor; the tool rejects other keys or
longer text. Only an explicit request changes the brief, not a question,
reading a story or a one-off story request. Hy confirms only after the tool
succeeds and otherwise says the change could not be saved. These rules live in
the tool description and preference context, so the apps no longer append them
to each message. Clearing uses `kind=neutral` on the existing key. The gateway derives identity from the running turn. Anonymous or
conflicting turn identities fail closed. A scheduled prompt uses the verified
task owner before the running-turn tool grant is established.

## Deployment and failure behavior

Deploy HybridClaw v0.36.0 or later and its rebuilt worker before releasing
the companion app update. Older runtimes cannot acknowledge the new command:
the apps keep pending events, show a sync error,
and retry on refresh rather than generating with unsent preferences.

Each app keeps an account-scoped durable outbox. It imports existing likes,
hidden titles, dismissed Ideas and the brief once at timestamp zero, so an
old phone cannot overwrite newer runtime feedback. Existing feed schedules
are upgraded once to remove embedded feedback snapshots, harvesting old
results before replacement. Later reactions leave that schedule intact.
Only acknowledged IDs leave the outbox; an acknowledgement cannot discard
a newer tap on the same item. Sign-out ends the account's sync work.

The local archive and read/bookmark UI state remain on each phone. Generation
uses the shared runtime record. This change does not migrate published stories
or add a cross-device archive.

## Risk and verification

Feedback is private user data, not executable instructions, permission grants,
or a source to cite in published content. The tool uses the established
master-authenticated gateway-tool transport and pins the calling session;
scheduled reads require verified ownership. Tests cover separate users,
missing/overlapping identities, malformed or oversized batches, retry ordering,
neutral feedback, the mobile command relay, and a running schedule observing
new feedback without a task replacement. Live model compliance and deployment
are separate from these deterministic checks.

## Implementation validation — 2026-10-04

- App repository: `scripts/check.sh` passed for iOS and Android (158 Swift
  tests and 163 Android tests); German strings and catalog synchronization
  are included.
- Runtime: `npm run typecheck`, `npm run lint`,
  `npm --prefix container run lint`, and `npm run build` passed with Node 22.
- Targeted runtime suites: `preferences`, `preferences-transport`,
  `scheduled-device-data`, and `chat-ideas` — 29 tests passed. The transport
  tests cover the worker-to-gateway boundary and pinned session identity.
- Runtime production delta: 327 net lines. Wiring adds 14 lines to
  `container/src/tools.ts`, four to `src/command-registry.ts`, four to
  `src/gateway/gateway-service.ts`, and nine to
  `src/gateway/gateway-http-server.ts`; behavior lives in the new preference
  modules. Preference kinds and the app wire contract cross language
  boundaries; model tool transport and command relay are tested.
- No release, live runtime restart or deployment was performed. Live model
  compliance tests were not run; deterministic tests verify that each
  generation receives the current record and that the write tool persists it.
- The implementation is in a separate runtime worktree to preserve unrelated
  work in the main checkout. Deploy the runtime and rebuilt worker first.
