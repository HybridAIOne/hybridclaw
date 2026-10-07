---
title: Shared notes
description: Persistent Markdown notebook pages shared by Hy and a person.
---

# Shared notes

Each registered agent has a notebook in its persistent workspace. Page titles,
parents and order live in `notes/index.json`; page content lives in
`notes/pages/<id>.md`. IDs do not change when a page is renamed or moved.
The index's page array determines sibling order. Archived pages retain their
content and hierarchy. Notes are working documents, separate from `MEMORY.md`.

The mobile apps use the authenticated gateway directly. `GET /api/notes`
requires `notes.read`; `POST /api/notes` requires `notes.write`. Hosted owner
phone handoffs grant both. Other paired phones retain their existing grants.
The caller supplies `agentId`, which must name a registered, active agent.
The response echoes that ID and `scope: "agent-notes"` for client validation.

## API

- `GET /api/notes?agentId=main`: pages and the index's SHA-256 `revision`.
- `GET /api/notes?agentId=main&id=<id>`: page, Markdown, content revision and history.
- Adding `revision=<sha256>` reads an earlier content version.
- `POST /api/notes?agentId=main`: one JSON operation.

Operations `create`, `scratchpad`, `rename`, `move`, `archive` and `unarchive`
require the current index revision. `create` takes a title, optional parent ID
and Markdown content. `scratchpad` takes its localized title and idempotently
creates the reserved `scratchpad` page. `rename` takes an ID and title. `move`
takes an ID, nullable parent ID and zero-based sibling position. Archive and
unarchive apply to the entire subtree; restoring a child with an archived
parent is refused. These operations return the updated index.

`save` takes an ID, the current content revision and new Markdown. It returns
the saved page. A stale revision returns 409 without replacing the existing
content. Restore is an ordinary save using an earlier version's content and
the current page revision, so undo cannot overwrite newer changes.

Content history lives in `notes/history/<id>/<revision>.md`. The latest 50
previous distinct content versions are retained. Notebook size is limited to
1,000 pages and 1 MB of UTF-8 text per page; titles are limited to 200 characters.
History covers content, not previous titles or parent relationships.

## Boundaries and failure modes

The API accepts page IDs rather than filesystem paths. Traversal IDs, symlinked
indexes, folders, pages and history files are refused. Reads use the existing
workspace file boundary. Writes use a cooperative notebook lock and atomic
replacement; this serializes app writes and any caller using the same API.
External filesystem editors do not participate in the lock. Content revisions
are rechecked by the existing Markdown writer before replacement.

Malformed indexes, missing parents and cycles fail rather than being repaired
or silently overwritten. A failed save leaves the caller's draft available for
review. A notebook lock surviving a gateway crash must be removed only after
confirming no writer is active; the API does not steal locks.

## Hy integration

The always-available `shared-notes` mini-skill directs Hy to discover pages,
read relevant content, and reconcile changes through the same notebook store.
Its helper uses the worker's gateway token and agent identity. `POST
/api/notes/runtime` uses the existing `agent.runtime` capability; its `list`
and `read` operations support model discovery, while writes use the same
operations, lock and revisions as the mobile API. The runtime credential is
shared by trusted workers on a gateway, as with other runtime tool callbacks;
it is not an independently restricted per-agent credential.

The helper accepts `list`, `read <id> [revision]`, and `apply` with a JSON
operation on stdin. `--request` prints a request without a bearer token for
inspection. It never retries writes. Returned page links use
`hybridclaw://notes/<id>?agentId=<runtime-agent-id>`; apps resolve these only
against agents in the signed-in configuration. Keep note bodies out of the
system prompt: read the relevant page afresh when the user asks about it.
