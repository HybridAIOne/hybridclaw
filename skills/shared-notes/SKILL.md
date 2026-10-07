---
name: shared-notes
description: Use the persistent notebook shared with the user for notes, plans, shopping lists and nested project pages.
mini: true
always: true
requires:
  bins: [node]
metadata:
  hybridclaw:
    category: productivity
---

Run `node /workspace/skills/shared-notes/notes.cjs list` to discover pages; `read <id> [revision]` reads content/history. Pass JSON on stdin to `notes.cjs apply`. Index operations use the list revision: `create`/`scratchpad` need title, optional parentId/content; `rename` needs id/title; `move` needs id/parentId (null for root)/position; `archive`/`unarchive` need id. `save` needs id, page revision and Markdown content. Read afresh before writing; on 409 reread and reconcile. Never overwrite blindly. Preserve the user's wording, order and completed items. Nest project pages under their parent. Use scratchpad for general shared notes; MEMORY.md stays private. Link the returned `link` with a descriptive label. Introduce the scratchpad after creating it, with one useful starting page grounded in what the user told you. Do not invent projects or promise unscheduled background work.
