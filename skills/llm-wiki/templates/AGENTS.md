# LLM Wiki Schema

This repository is a maintained knowledge base. Treat it like a living wiki,
not a loose pile of notes.

## Session Start

Before ingesting, querying, linting, archiving, or doing broad cleanup:

1. read this file
2. read `index.md`
3. read recent entries from `log.md`
4. search existing wiki pages before creating anything new

## Core Layout

- `raw/` contains immutable source material.
- `wiki/` contains maintained knowledge pages written by the assistant.
- `index.md` is the content index.
- `log.md` is the append-only activity log.

## Domain

Adapt this section to the actual domain of the wiki. State what belongs here,
what does not, and any domain-specific tags or page types.

## Page Families

- `wiki/sources/` for source summaries
- `wiki/entities/` for people, organizations, products, places, or other
  durable entities
- `wiki/concepts/` for themes, ideas, frameworks, or topics
- `wiki/analyses/` for durable answers, comparisons, timelines, and synthesis

Create additional subdirectories only when the existing families are no longer
enough.

## Frontmatter

When there is no stronger local convention, maintained pages should start with:

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

## Tag Taxonomy

Keep a bounded taxonomy here and add new tags before using them on pages.
Suggested starter tags:

- `source`
- `entity`
- `concept`
- `analysis`
- `company`
- `person`
- `product`
- `timeline`
- `open-question`
- `hypothesis`
- `contradiction`

## Page Thresholds

- Create a page when a concept or entity is central to one source or appears
  meaningfully across multiple sources.
- Update an existing page when new material mainly extends what is already
  covered.
- Do not create pages for passing mentions.
- Split pages when they stop being scannable.
- Archive pages when they are clearly superseded and no longer useful as live
  pages.

## Working Rules

- Never modify source files in `raw/` during normal ingest.
- Read before write. Update existing pages instead of creating duplicates.
- Keep `index.md` current whenever pages are added, renamed, or retired.
- Append a log entry to `log.md` for initialization, ingest, query artifacts,
  and meaningful lint passes.
- Make provenance explicit. Facts should cite a source page, raw source, or a
  clearly marked inference.
- Flag contradictions instead of smoothing them over.

## Lint Checks

When asked to lint the wiki, check for:

- orphan pages
- broken links
- invalid or missing frontmatter
- tags not present in the taxonomy
- stale claims superseded by newer sources
- contradictions between related pages
- pages missing from `index.md`
- entries in `index.md` that no longer exist
- logs that should be rotated

## Archive Workflow

When a page is archived:

- update or remove its index entry
- update important inbound links or note that it was archived
- log the archive action and the reason

## Vaults

If this wiki lives in an Obsidian vault, preserve the vault's existing
conventions and use the separate `obsidian` skill for vault-specific behavior.

## Default Page Shape

When there is no stronger local convention, prefer:

1. short summary
2. key points or claims
3. evidence or citations
4. related pages
5. open questions

## Link Style

If this repository already uses wikilinks, preserve them. Otherwise use
relative Markdown links.
