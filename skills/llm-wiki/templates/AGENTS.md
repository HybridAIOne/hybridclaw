# LLM Wiki Schema

This repository is a maintained knowledge base. Treat it like a living wiki,
not a loose pile of notes.

## Core Layout

- `raw/` contains immutable source material.
- `wiki/` contains maintained knowledge pages written by the assistant.
- `index.md` is the content index.
- `log.md` is the append-only activity log.

## Page Families

- `wiki/sources/` for source summaries
- `wiki/entities/` for people, organizations, products, places, or other
  durable entities
- `wiki/concepts/` for themes, ideas, frameworks, or topics
- `wiki/analyses/` for durable answers, comparisons, timelines, and synthesis

Create additional subdirectories only when the existing families are no longer
enough.

## Working Rules

- Never modify source files in `raw/` during normal ingest.
- Read before write. Update existing pages instead of creating duplicates.
- Keep `index.md` current whenever pages are added, renamed, or retired.
- Append a log entry to `log.md` for initialization, ingest, query artifacts,
  and meaningful lint passes.
- Make provenance explicit. Facts should cite a source page, raw source, or a
  clearly marked inference.
- Flag contradictions instead of smoothing them over.

## Default Page Shape

When there is no stronger local convention, prefer:

1. short summary
2. key points or claims
3. evidence or citations
4. related pages
5. open questions

## Link Style

If this repository is used as an Obsidian vault or already uses wikilinks,
prefer wikilinks. Otherwise use relative Markdown links.
