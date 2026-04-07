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
3. a confirmed Obsidian vault if the user wants the wiki inside Obsidian
4. the current workspace only if the user explicitly wants the wiki here

Do not assume the current workspace is the wiki root just because it contains
Markdown files.

If the target is an Obsidian vault, also follow `skills/obsidian/SKILL.md` for
vault-safe behavior.

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

### Recommended Frontmatter

When there is no stronger local convention, maintained pages should begin with:

```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: source | entity | concept | analysis
tags: [tag-a, tag-b]
sources:
  - raw/path-or-source-summary
---
```

`raw/` files do not need frontmatter unless the user already uses it there.

### Tag Taxonomy

Do not let tags grow ad hoc. Keep a bounded taxonomy in `AGENTS.md`, and add
new tags there before using them on pages. A useful starter taxonomy often
includes:

- `source`, `entity`, `concept`, `analysis`
- domain tags such as `company`, `person`, `product`, `model`, `timeline`
- state tags such as `open-question`, `hypothesis`, `contradiction`

If the user gave a specific domain, adapt the taxonomy to that domain instead
of keeping these generic labels.

### Page Thresholds

When there is no stronger local rule in the wiki:

- create a new page when a concept or entity is central to one source or
  appears meaningfully across multiple sources
- update an existing page when the source mainly adds facts to something already
  covered
- do not create a page for a passing mention
- split a page when it becomes too large or stops being scannable
- archive a page when it is superseded and no longer useful as a live page

Prefer richer existing pages over a larger count of shallow near-duplicates.

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

When the user asks for a health check, audit the wiki for:

- orphan pages with no meaningful inbound references
- broken links or wikilinks
- frontmatter validation issues on maintained pages
- tags that are missing from the local taxonomy
- stale claims superseded by newer sources
- contradictions between related pages
- pages that should be split because they are too large or overloaded
- index entries that no longer match the filesystem
- pages missing from `index.md`
- oversized or stale `log.md` files that should be rotated
- missing follow-up questions or obvious source gaps

When possible, group findings by severity:

1. broken links, missing pages, invalid frontmatter
2. contradictions, stale claims, missing index entries
3. orphans, oversized pages, taxonomy cleanup, follow-up gaps

Record meaningful lint passes in `log.md`.

## Working With The Wiki

### Bulk Ingest

When ingesting multiple sources at once:

1. read all sources first
2. identify shared entities and concepts across the batch
3. search the wiki once before writing
4. update all affected pages in one pass
5. update `index.md` once at the end
6. write one clear batch entry to `log.md`

### Archive Workflow

When content is fully superseded or no longer belongs in the live wiki:

1. move it into an archive area only if the user wants archival retention
2. remove or update its index entry
3. update inbound links or note the page was archived
4. log the archive action and why it happened

Do not archive aggressively. Archive when it preserves clarity, not just to
reduce page count.

### Obsidian Guidance

If the wiki lives in an Obsidian vault:

- prefer wikilinks when that vault already uses them
- keep attachment-like assets under `raw/assets/`
- preserve vault conventions instead of imposing new ones

For headless or synced setups, keep the guidance conceptual unless the user
explicitly asks for sync or automation steps. The wiki should remain plain
markdown that works without any proprietary integration.

## Page Conventions

- Use clear, stable file names.
- Prefer updating an existing page over creating near-duplicates.
- Keep maintained pages scannable and easy to navigate.
- Match the surrounding link style:
  use Obsidian wikilinks in vaults that already use them; otherwise use
  relative Markdown links.
- Keep provenance explicit. Every non-trivial factual claim should be traceable
  to a source page, a raw source, or a clearly labeled inference.
- Mark hypotheses, open questions, and unresolved conflicts explicitly.
- Every created or materially updated page should be reflected in `index.md`
  and `log.md`.

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
- Do not use freeform tags without updating the taxonomy in `AGENTS.md`.
- Do not let `index.md` or `log.md` drift behind the actual wiki state.
