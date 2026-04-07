---
name: llm-wiki
description: Build and maintain a persistent markdown wiki from raw sources using incremental ingest, indexed pages, and append-only logging.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - wiki
      - knowledge-base
      - research
      - markdown
      - obsidian
    related_skills:
      - obsidian
      - pdf
      - notion
---

# LLM Wiki

Use this skill when the user wants a persistent knowledge base that compounds
over time instead of answering from raw documents from scratch on every turn.

## Core Model

Treat the wiki as three layers:

- `raw/` is the immutable source collection. Read from it; do not edit or
  rewrite it.
- `wiki/` is the maintained knowledge layer. This is where summaries, entity
  pages, concept pages, and durable analyses live.
- `AGENTS.md`, `index.md`, and `log.md` define and track the system:
  `AGENTS.md` is the schema and workflow contract, `index.md` is the catalog,
  and `log.md` is the append-only timeline.

This is not a one-shot note dump. The goal is to integrate new information into
existing pages, preserve cross-references, and keep the wiki internally
coherent as the source set grows.

## Resolve The Wiki Root

Use this order:

1. a user-specified wiki root
2. an already-structured repo or vault containing `raw/`, `wiki/`, `index.md`,
   and `log.md`
3. a confirmed Obsidian vault if the user wants the wiki inside Obsidian
4. the current workspace only if the user explicitly wants the wiki here

Do not assume the current workspace is the wiki root just because it contains
Markdown files.

If the target is an Obsidian vault, also follow `skills/obsidian/SKILL.md` for
vault-safe behavior.

## Default Layout

Unless the user already has a stronger convention, initialize or preserve this
shape:

- `raw/`
- `raw/assets/`
- `wiki/`
- `wiki/sources/`
- `wiki/entities/`
- `wiki/concepts/`
- `wiki/analyses/`
- `index.md`
- `log.md`
- `AGENTS.md`

Use the starter files in `skills/llm-wiki/templates/` when bootstrapping a new
wiki. Copy only missing files unless the user asks to replace existing ones.

## Initialization Workflow

When the wiki does not exist yet:

1. Confirm the wiki root.
2. Create the default layout.
3. Seed missing starter files from `skills/llm-wiki/templates/`.
4. Adapt `AGENTS.md` to the user's domain if they gave one.
5. Add an initialization entry to `log.md`.

Do not overwrite an existing `AGENTS.md`, `index.md`, or `log.md` without
reading them first.

## Ingest Workflow

When the user asks to ingest a source:

1. Read the source from `raw/` or the user-provided path.
2. Create or update a source summary page under `wiki/sources/`.
3. Update relevant entity, concept, and analysis pages instead of duplicating
   facts across many unrelated notes.
4. Update `index.md` for every created or renamed page.
5. Append a structured entry to `log.md`.

Preferred source page sections:

- summary
- key facts
- claims and evidence
- related entities or concepts
- open questions
- source details

Favor synthesis over excerpt hoarding. Pull forward the durable information and
cite where it came from.

## Query Workflow

When answering a wiki question:

1. Read `index.md` first to find the right pages.
2. Read only the relevant wiki pages and source summaries.
3. Answer with citations back to wiki pages and, when helpful, raw sources.
4. If the answer is durable, save it under `wiki/analyses/` and log it.

Do not pretend the wiki is comprehensive. Call out gaps or contradictions
clearly.

## Lint Workflow

When the user asks for a health check, inspect the wiki for:

- contradictions between pages
- stale claims superseded by newer sources
- orphan pages with no useful inbound references
- concepts or entities that deserve their own pages
- broken links
- index entries that no longer match the filesystem
- missing follow-up questions or source gaps

Record meaningful lint passes in `log.md`.

## Page Conventions

- Use clear, stable file names.
- Prefer updating an existing page over creating near-duplicates.
- Match the surrounding link style:
  use Obsidian wikilinks in vaults that already use them; otherwise use
  relative Markdown links.
- Keep provenance explicit. Every non-trivial factual claim should be traceable
  to a source page, a raw source, or a clearly labeled inference.
- Mark hypotheses, open questions, and unresolved conflicts explicitly.

## Logging Convention

Use headings like:

```md
## [2026-04-07] ingest | Source Title
## [2026-04-07] query | Market map of competitors
## [2026-04-07] lint | Weekly health check
```

Keep log entries concise but specific about what changed.

## Pitfalls

- Do not edit or delete files under `raw/` unless the user explicitly asks.
- Do not answer solely from raw sources when the wiki already contains the
  relevant synthesis.
- Do not create placeholder pages with no substance just to increase coverage.
- Do not let `index.md` or `log.md` drift behind the actual wiki state.
