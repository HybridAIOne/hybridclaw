---
name: hermes3000-writing
description: Use Hermes3000 to plan, draft, revise, save, check consistency, and export long-form manuscripts through the Hermes3000 AI writing portal API. Use for novels, fiction series, nonfiction books, whitepapers, long reads, chapter outlines, character/world-building, style guides, consistency memory, and DOCX/PDF/EPUB/HTML exports.
requires:
  bins:
    - node
credentials:
  - id: hermes3000-jwt
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: HERMES3000_JWT
    scope: "hermes3000.ai"
    how_to_obtain: "Store HERMES3000_EMAIL and HERMES3000_PASSWORD in HybridClaw runtime secrets, then run the bundled auth.login helper so the gateway captures the login JWT into HERMES3000_JWT without exposing it to the agent."
metadata:
  hybridclaw:
    category: productivity
    short_description: "Hermes3000 portal workflow for long-form writing."
    tags:
      - hermes3000
      - writing
      - novels
      - whitepapers
      - long-reads
---

# Hermes3000 Writing

## Overview

Use Hermes3000 when the user wants a durable long-form writing project managed
in the writing portal, not just a one-off draft in chat. Hermes3000 stores book
structure, chapter content, consistency memory, timeline data, stats, and
exports.

For endpoint details, request shapes, and examples, read
`references/api-workflow.md` before making live API calls.

## Secret Refs

The bundled helper sends all live Hermes3000 calls through the HybridClaw
gateway proxy, matching the Salesforce skill pattern. Login credentials are
sent as `<secret:NAME>` placeholders; the gateway resolves them server-side,
captures the returned Hermes3000 JWT into `HERMES3000_JWT`, and returns only a
capture confirmation. The JWT does not enter the agent context.

Never call Hermes3000 with `curl` or a raw `Authorization: Bearer ...` header.
Use `node skills/hermes3000-writing/scripts/hermes3000.cjs ... run ...` for
live calls so the gateway injects and captures secrets server-side.
Run these helper commands exactly as documented. Do not add Node permission
flags such as `--experimental-permission`, and do not rewrite `skills/...`
paths to `/workspace/skills/...`; the helper needs runtime-provided gateway
access for secret resolution.

Cloud and chat/TUI users may not have a terminal. Only ask the user to set
secrets with chat/TUI secret commands; do not ask them to run `node`, `curl`, or
`hybridclaw` shell commands. If `HERMES3000_JWT` is missing or blocked, run
`auth.login` yourself through the helper. The helper does not prompt for email
or password; it resolves `HERMES3000_EMAIL` and `HERMES3000_PASSWORD` from the
gateway secret store.

Ask the user to set the login inputs once from chat or TUI:

```text
/secret set HERMES3000_EMAIL you@example.com
/secret set HERMES3000_PASSWORD <password>
```

For local operator setup only, the shell-side equivalent is:

```bash
hybridclaw secret set HERMES3000_EMAIL you@example.com
hybridclaw secret set HERMES3000_PASSWORD '<password>'
```

Then the agent, not the user, captures the JWT through the gateway:

```bash
node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run auth.login
```

On success, the gateway stores `HERMES3000_JWT`. Subsequent helper operations
set `bearerSecretName: "HERMES3000_JWT"` internally so the gateway injects the
bearer token server-side.

## Operating Rules

1. Preserve author control. Ask for or infer the manuscript premise, audience,
   language, target length, genre or content type, tone, and export format before
   creating or replacing durable portal content.
2. Treat credentials and JWTs as secrets. Authenticate through the active
   runtime's secret or credential mechanism when available. Do not print tokens,
   paste passwords into chat, or store credentials in project files.
3. Prefer the synchronous generation endpoint for agents:
   `POST /ai/generate-text`. Use streaming only when the active runtime has a
   clear SSE reader and the user needs progress output.
4. Save every accepted chapter draft with `POST /books/{id}/content`, then build
   consistency memory with `POST /consistency/chapter-summary` before writing the
   next chapter.
5. Use stable chapter UUIDs. When AI-generated chapters do not include `id`,
   generate UUID v4 values before saving the `chapters` structure.
6. Keep portal state coherent. Update `plot`, `characters`, `style`, and
   `chapters` before generating chapter prose; update story progress after
   summaries with `POST /consistency/update-story`.
7. Do not overwrite an existing book, chapter, structure element, or content
   block unless the user explicitly asks for replacement. Fetch current state
   first when editing an existing project.

## Project Shape

Choose the Hermes3000 `bookType` from the user's goal:

- `prose`: novels, novellas, fiction series, narrative long reads.
- `nonfiction`: nonfiction books, educational material, manuals, essays.
- `whitepaper`: short-form whitepapers, reports, thought-leadership papers.

Represent structure as:

- `plot`: Markdown outline of the argument, storyline, or thesis.
- `characters`: Markdown profiles for fiction characters, or key people,
  personas, stakeholders, examples, and cited experts for nonfiction.
- `style`: Markdown writing rules: language, voice, perspective, reading level,
  terminology, citation stance, formatting preferences, and banned patterns.
- `places_things`: Markdown world-building, concepts, definitions, datasets,
  products, organizations, or repeated motifs.
- `chapters`: Array of `{id, title, summary}` objects.

## Workflow

1. List or authenticate through the helper. If a live call fails because
   `HERMES3000_JWT` is missing or blocked, run `run auth.login` yourself. If
   login fails because `HERMES3000_EMAIL` or `HERMES3000_PASSWORD` is missing,
   ask the user to set those two secrets with `/secret set ...`. Never ask the
   user to run terminal commands and never ask for or print the bearer token.
2. Create or select the book. For a new book, call `POST /books` with `title`
   and `bookType`.
3. Build planning material. Either draft it yourself from the user's brief or
   use `POST /ai/generate-plot` and `POST /ai/generate-chapters`.
4. Save structure with repeated `PUT /books/{id}/structure` calls for `plot`,
   `characters`, `style`, optional `places_things`, and `chapters`.
5. For each chapter:
   - Update agent state if the user wants progress visible in the portal.
   - Generate text with `POST /ai/generate-text`.
   - Review for user constraints, obvious factual issues, and continuity.
   - Save approved text with `POST /books/{id}/content`.
   - Summarize it with `POST /consistency/chapter-summary`.
6. After a complete drafting pass, call `POST /consistency/update-story`, fetch
   stats, and run consistency checks on risky sections.
7. Export with `GET /books/{id}/download/{format}` when the user asks for a
   deliverable. Supported formats are `pdf`, `docx`, `epub`, and `html`.

## Command Contract

Run login and API requests through the gateway-proxied helper. Copy these
commands exactly, changing only the operation arguments such as title, book id,
or file paths:

```bash
node skills/hermes3000-writing/scripts/hermes3000.cjs --help
```

Capture the JWT into the secret store:

```bash
node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run auth.login
```

This is an agent-side command. Do not show it to chat/TUI users as something
they need to run.

Create a book:

```bash
node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run books.create \
  --title "Working Title" \
  --book-type prose
```

Save a Markdown structure element:

```bash
node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run structure.put \
  --book-id 42 \
  --structure-type plot \
  --content-file plot.md
```

Save chapters with UUIDs:

```bash
node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run structure.put \
  --book-id 42 \
  --structure-type chapters \
  --content-json '[{"id":"550e8400-e29b-41d4-a716-446655440000","title":"Chapter 1","summary":"Opening movement."}]'
```

Generate and save chapter text:

```bash
node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run ai.generate-text \
  --book-id 42 \
  --chapter-id "Chapter 1" \
  --prompt "Write the opening scene."

node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run content.save \
  --book-id 42 \
  --chapter-uuid 550e8400-e29b-41d4-a716-446655440000 \
  --content-file chapter-1.html
```

Build consistency memory and export:

```bash
node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run consistency.chapter-summary \
  --book-id 42 \
  --chapter-id "Chapter 1" \
  --chapter-uuid 550e8400-e29b-41d4-a716-446655440000 \
  --chapter-content-file chapter-1.html \
  --narrative-order 0 \
  --lang en

node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run consistency.update-story --book-id 42
node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run export.download --book-id 42 --export-format docx
```

## Writing Guidance

- For novels, make the chapter prompt scene-specific: point of view, location,
  time, objective, conflict, emotional turn, continuity constraints, and ending
  beat.
- For nonfiction and whitepapers, make the chapter prompt argument-specific:
  audience, claim, evidence to use, terms to define, examples, counterarguments,
  and desired takeaway.
- For long reads, prefer shorter content blocks per chapter section so revision
  remains manageable.
- Use `POST /consistency/check` when new text might contradict earlier claims,
  timeline, character state, terminology, or technical definitions.
- Keep generated HTML returned by Hermes3000 intact unless the target content
  block should be plain text.

## Error Handling

- `401` means login failed or the token expired; re-authenticate through the
  secure credential path.
- `402` means account limits or payment requirements blocked book creation.
  Report it plainly; do not retry creation.
- `403` usually means unverified email, insufficient account level, or missing
  ownership. Fetch book metadata only if authorized.
- `404` means the book, structure, chapter, or content block is unavailable to
  the current user.
- If generation succeeds but saving fails, keep the generated text in the
  current response or workspace artifact only when it does not expose secrets or
  private source material, then ask before retrying.
