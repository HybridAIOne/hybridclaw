# Hermes3000 API Workflow Reference

Source: `https://hermes3000.ai/api-docs/` and raw OpenAPI at
`https://hermes3000.ai/api/openapi`.

Base server in the OpenAPI document is `/api`; use
`https://hermes3000.ai/api` for public hosted calls unless the user provides a
different Hermes3000 base URL.

## Authentication

All endpoints except registration and login require:

```text
Authorization: Bearer <jwt>
```

Login:

```http
POST /auth/login
Content-Type: application/json

{
  "email": "agent@example.com",
  "password": "securepassword123"
}
```

The response includes `token` and `user`. The JWT is valid for 7 days. Keep it
private.

In HybridClaw, do not call login in a way that returns `token` to the agent.
Use the bundled helper's gateway-backed `run` mode:

```bash
node skills/hermes3000-writing/scripts/hermes3000.cjs --format json run auth.login
```

The helper posts to the HybridClaw gateway proxy. It uses
`captureResponseFields: [{ "jsonPath": "token", "secretName": "HERMES3000_JWT" }]`
so the gateway stores the JWT and returns only a capture confirmation.
Subsequent helper requests use `bearerSecretName: "HERMES3000_JWT"`.

Do not use `curl` with a raw Hermes3000 `Authorization` header. If a runtime
does not allow direct helper execution but does expose the built-in
`http_request` tool, use the helper's `http-request` mode and pass only the
emitted `httpRequest` object to that tool.

## Core Book Workflow

1. `POST /books` with `{ "title": "...", "bookType": "prose|nonfiction|whitepaper" }`.
2. Save structure with `PUT /books/{id}/structure`.
3. Generate chapter text with `POST /ai/generate-text`.
4. Save text with `POST /books/{id}/content`.
5. Summarize the chapter with `POST /consistency/chapter-summary`.
6. Repeat generation, save, and summary for every chapter.
7. Recalculate story state with `POST /consistency/update-story`.
8. Export with `GET /books/{id}/download/{format}`.

## Book Types

- `prose`: fiction.
- `nonfiction`: nonfiction books and educational material.
- `whitepaper`: short-form whitepapers and reports.

`POST /books` requires `title`; `bookType` defaults to `prose`. Additional free
tier books may require `paymentId`.

## Structure

Save each structure element with:

```http
PUT /books/{id}/structure
Content-Type: application/json

{
  "structureType": "plot",
  "content": "## Act 1\n..."
}
```

Allowed `structureType` values:

- `plot`: Markdown plot, thesis, argument, or topic outline.
- `characters`: Markdown character profiles, personas, key persons, or experts.
- `style`: Markdown style, tone, perspective, terminology, and voice rules.
- `places_things`: Markdown settings, concepts, definitions, products, or motifs.
- `clipboard`: temporary user clipboard content.
- `chapters`: JSON array of `{ "id": "<uuid>", "title": "...", "summary": "..." }`.

For `chapters`, generate UUID v4 ids before saving if the source outline lacks
ids.

Fetch full state with `GET /books/{id}`. Fetch one structure element with
`GET /books/{id}/structure/{structureType}`.

## AI Planning

Generate plot suggestions:

```http
POST /ai/generate-plot
Content-Type: application/json

{
  "bookId": 42,
  "plotType": "freetext",
  "freetextPrompt": "A concise premise or whitepaper thesis...",
  "additionalInfo": "Audience, genre, tone, constraints."
}
```

Returns 3 Markdown suggestions. Pick or merge one and save it as `plot`.

Generate chapter outline:

```http
POST /ai/generate-chapters
Content-Type: application/json

{
  "bookId": 42,
  "chapterCount": 12,
  "additionalInfo": "Desired pacing or section constraints."
}
```

The book must already have a `plot` of at least 50 characters. The response
contains chapter `{title, summary}` objects; add UUIDs before saving to
`structureType: "chapters"`.

## Text Generation

Recommended endpoint:

```http
POST /ai/generate-text
Content-Type: application/json

{
  "bookId": 42,
  "chapterId": "Chapter 1 - The Beginning",
  "prompt": "Write the opening scene...",
  "context": "Additional constraints or source notes."
}
```

Required fields are `bookId` and `prompt`. `chapterId` is the chapter title and
is used for consistency context loading. The response is:

```json
{ "text": "<p>Generated text, often HTML formatted.</p>" }
```

Streaming alternative:

```http
POST /ai/generate-text-stream
```

It emits SSE `data:` JSON events with `token`, `done`, or `error`. Prefer the
synchronous endpoint for agent automation.

## Content Blocks

Save text after generation:

```http
POST /books/{id}/content
Content-Type: application/json

{
  "chapterUuid": "550e8400-e29b-41d4-a716-446655440000",
  "chapterId": "Chapter 1 - The Beginning",
  "heading": "Opening Scene",
  "content": "<p>Generated text...</p>",
  "contentType": "text",
  "orderIndex": 0
}
```

Use `chapterUuid` when possible. `contentType` can be `text`, `image`,
`interactive`, `html`, or `chatbot`; default is `text`.

Update existing content with `PUT /books/{id}/content/{contentId}`. Delete with
`DELETE /books/{id}/content/{contentId}` only when explicitly requested.

## Consistency Memory

After saving each chapter, summarize it:

```http
POST /consistency/chapter-summary
Content-Type: application/json

{
  "bookId": 42,
  "chapterId": "Chapter 1 - The Beginning",
  "chapterTitle": "Chapter 1 - The Beginning",
  "chapterUuid": "550e8400-e29b-41d4-a716-446655440000",
  "chapterContent": "<p>Full chapter text...</p>",
  "narrativeOrder": 0,
  "lang": "en"
}
```

Supported `lang` values are `de`, `en`, `fr`, and `es`; default is `de`.

Recalculate the aggregate story state after summaries:

```http
POST /consistency/update-story
Content-Type: application/json

{ "bookId": 42 }
```

Inspect consistency state:

- `GET /consistency/context/{bookId}/{chapterId}`.
- `GET /consistency/summaries/{bookId}`.
- `GET /consistency/story-progress/{bookId}`.

Check risky text:

```http
POST /consistency/check
Content-Type: application/json

{
  "bookId": 42,
  "chapterTitle": "Chapter 7 - Reversal",
  "content": "Text to check..."
}
```

## Import, Stats, and Progress

Import an existing manuscript:

```http
POST /books/import
Content-Type: application/json

{
  "content": "# Chapter 1\n...",
  "format": "markdown",
  "title": "Imported Draft",
  "filename": "draft.md",
  "bookType": "prose"
}
```

Supported import formats are `markdown`, `text`, and `docx`; DOCX content is
base64.

Fetch stats with `GET /books/{id}/stats`. Stats include word count, character
count, Normseiten, chapter counts, active chapter, and agent state.

Optionally update visible agent progress:

```http
PATCH /books/{id}/agent-state
Content-Type: application/json

{
  "current_chapter_id": "Chapter 2 - The Journey",
  "agent_state": {
    "status": "generating_chapter",
    "progress": 0.4,
    "message": "Drafting section 3"
  }
}
```

## Export

Export:

```http
GET /books/{id}/download/{format}
```

Supported `format` values are `pdf`, `docx`, `epub`, and `html`.

Optional query: `normseite=true` for PDF or DOCX only. Normseite is the German
publishing layout standard.

## Common Status Codes

- `400`: missing or invalid payload fields.
- `401`: invalid credentials or expired bearer token.
- `402`: payment required for additional book creation.
- `403`: account or ownership restriction.
- `404`: book, content, structure, or share token not found for this user.
