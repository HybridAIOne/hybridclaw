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
    related_skills:
      - pdf
      - notion
---

# LLM Wiki

Use this skill when the user wants a persistent knowledge base that compounds
over time instead of answering from raw documents from scratch on every turn.

## Core Model

Treat the wiki as three layers:

- `raw/` is the immutable source collection. Read from it; do not edit or
  rewrite it during normal maintenance.
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
3. a confirmed markdown vault or notes repo chosen by the user
4. the current workspace only if the user explicitly wants the wiki here

Do not assume the current workspace is the wiki root just because it contains
Markdown files.

If the target is an Obsidian vault, also follow `skills/obsidian/SKILL.md`.

## Orient Every Session

When the user already has a wiki, always orient yourself before acting:

1. Read `AGENTS.md` first to understand the local schema, domain, taxonomy,
   link style, and workflow rules.
2. Read `index.md` to learn what pages exist and how the wiki is organized.
3. Read the most recent entries in `log.md` to understand recent ingest, query,
   lint, archive, and cleanup activity.
4. For large wikis, search the relevant topic across `wiki/**/*.md` before
   creating anything new.

Do this every session before ingest, query, lint, archive, or broad cleanup.
Skipping orientation causes duplicate pages, weak cross-references, and schema
drift.

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

## Schema Contract

`AGENTS.md` is the local schema for the wiki. It should define:

- the domain and out-of-scope topics
- file naming and link conventions
- the frontmatter contract for maintained pages
- the allowed tag taxonomy
- page thresholds for create vs update vs split
- update policy for contradictions and superseded claims

When bootstrapping or upgrading a wiki, make sure `AGENTS.md` contains a usable
schema, not just a short description.

The authoritative default schema lives in
`skills/llm-wiki/templates/AGENTS.md`. Use that file as the source of truth for
default frontmatter, taxonomy, page thresholds, lint checks, archive behavior,
and link style. Adapt the copied `AGENTS.md` to the user's domain
instead of duplicating those defaults here.

## Ingest Workflow

When the user asks to ingest a source:

1. Orient first by reading `AGENTS.md`, `index.md`, and recent `log.md`.
2. Capture or read the source from `raw/` or the user-provided path.
3. Create or update a source summary page under `wiki/sources/`.
4. Search the wiki for relevant entities, concepts, and analyses before
   creating anything new.
5. Update relevant entity, concept, and analysis pages instead of duplicating
   facts across many unrelated notes.
6. Update `index.md` for every created, renamed, archived, or merged page.
7. Append a structured entry to `log.md` listing the files created or updated.

Preferred source page sections:

- summary
- key facts
- claims and evidence
- related entities or concepts
- open questions
- source details

Favor synthesis over excerpt hoarding. Pull forward the durable information and
cite where it came from.

When a source conflicts with existing wiki content:

1. check dates and provenance
2. record both positions if the conflict is real
3. mark the disagreement explicitly in the affected page
4. surface it in lint results if still unresolved

If one ingest would touch many pages, narrate the scope clearly before making a
large coordinated update.

Apply the local `AGENTS.md` rules for frontmatter, tags, thresholds, page
shape, and link style. If the wiki still uses the default bundled schema, that
means following the defaults copied from `skills/llm-wiki/templates/AGENTS.md`.

## Query Workflow

When answering a wiki question:

1. Orient first.
2. Read `index.md` to find the relevant pages.
3. For large wikis, search for key terms across the wiki before choosing pages.
4. Read only the relevant wiki pages and source summaries.
5. Answer with citations back to wiki pages and, when helpful, raw sources.
6. If the answer is durable, save it under `wiki/analyses/` and log it.

Do not pretend the wiki is comprehensive. Call out gaps, unresolved questions,
and contradictions clearly.

## Lint Workflow

When the user asks for a health check, audit the wiki against the rules in the
local `AGENTS.md`.

If the wiki uses the bundled default schema, the checks in
`skills/llm-wiki/templates/AGENTS.md` are authoritative. Report findings by
severity, then record meaningful lint passes in `log.md`.

## Working With The Wiki

### Bulk Ingest

When ingesting multiple sources at once:

1. read all sources first
2. identify shared entities and concepts across the batch
3. search the wiki once before writing
4. update all affected pages in one pass
5. update `index.md` once at the end
6. write one clear batch entry to `log.md`

For archive behavior, page shape, link style, and other
schema defaults, defer to the local `AGENTS.md`. If the wiki was bootstrapped
from the bundled defaults, `skills/llm-wiki/templates/AGENTS.md` is the
authoritative reference.

## Logging Convention

Use headings like:

```md
## [2026-04-07] create | Wiki initialized
## [2026-04-07] ingest | Source Title
## [2026-04-07] query | Market map of competitors
## [2026-04-07] lint | Weekly health check
## [2026-04-07] archive | Superseded page
```

Keep log entries concise but specific about what changed, which files moved, and
what follow-ups remain. Rotate long logs when they stop being usable.

## Pitfalls

- Do not edit or delete files under `raw/` unless the user explicitly asks.
- Do not skip orientation on an existing wiki.
- Do not answer solely from raw sources when the wiki already contains the
  relevant synthesis.
- Do not create placeholder pages with no substance just to increase coverage.
- Do not drift from the local `AGENTS.md` schema defaults or customizations.
- Do not let `index.md` or `log.md` drift behind the actual wiki state.
