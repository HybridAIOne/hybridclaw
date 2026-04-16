---
title: Memory & Knowledge Skills
description: Wikis, Notion, Obsidian, Zettelkasten, and persona management.
sidebar_position: 7
---

# Memory & Knowledge Skills

## llm-wiki

Build and maintain a persistent markdown wiki from raw sources using
incremental ingest, indexed pages, and append-only logging.

**Prerequisites** — none (pure markdown on disk).

> 💡 **Tips & Tricks**
>
> Three-layer model: `raw/` (immutable sources), `wiki/` (maintained knowledge), system files (`index.md`, `log.md`).
>
> The skill orients itself every session by reading `AGENTS.md`, `index.md`, and recent log entries.
>
> It searches existing pages before creating new ones — avoids duplication.

> 🎯 **Try it yourself**
>
> `Initialize a wiki in ./research-wiki for my thesis on distributed consensus algorithms`
>
> `Ingest ./papers/raft-2014.pdf into the wiki and create entity pages for the key authors and concepts mentioned`
>
> `What does the wiki say about "transformer architecture"?`
>
> `Run a lint pass on the wiki and fix any broken cross-references`
>
> `Ingest the three PDFs in ./papers/, create entity pages for key authors, cross-reference overlapping concepts between the papers, and update the wiki index`

---

## notion

Search, create, update, and organize Notion pages, databases, notes, and
trackers through the Notion API.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| Notion internal integration | API access | Create at `https://www.notion.so/my-integrations` |
| `NOTION_API_KEY` | Authentication | Store integration token as environment variable or HybridClaw secret |

Share target pages/databases with the integration in Notion's UI.

> 💡 **Tips & Tricks**
>
> Distinguish `database_id` (for creating pages) from `data_source_id` (for querying data) — they are different things.
>
> Show proposed content to the user before writing to Notion.
>
> Prefer Notion databases for structured/repeating tasks over free-form pages.

> 🎯 **Try it yourself**
>
> `Search my Notion workspace for pages about "Q2 planning"`
>
> `Create a new page in the "Meeting Notes" database titled "Standup 2026-04-16" with attendees: Alice, Bob; discussed: API migration progress; blockers: staging env down`
>
> `Add a row to my project tracker database with title "Auth refactor", status "In Progress", and priority "High"`
>
> `Search for all pages tagged "Q1 review", read their contents, and create a new summary page in the "Quarterly Reports" database combining the key takeaways`

**Troubleshooting**

- **404 on page access** — the integration hasn't been shared with that page.
  Open the page in Notion, Share, and invite your integration.
- **Rate limited** — Notion's API rate limit is 3 requests/second. The skill
  respects this automatically.

---

## obsidian

Read, search, organize, and create notes in an Obsidian vault.

**Prerequisites** — an Obsidian vault (any folder with `.md` files).
Optionally `obsidian-cli` for richer queries.

> 💡 **Tips & Tricks**
>
> The skill resolves vault location from: user-provided path, remembered path, `OBSIDIAN_VAULT_PATH` env var, `obsidian-cli`, macOS config, or common defaults.
>
> Always uses `[[wikilinks]]` matching the vault's existing link style.
>
> Searches existing notes before creating new ones.

> 🎯 **Try it yourself**
>
> `Find all notes in my vault tagged with #project-alpha`
>
> `Create a new daily note for today with a link to yesterday's note`
>
> `Search the vault for mentions of "API rate limiting"`
>
> `Search my vault for all notes mentioning "API design", create a new MOC (Map of Content) note linking them together, and add backlinks from each source note to the new MOC`

---

## personality

Switch persona modes and persist the active mode in `SOUL.md`.

**Prerequisites** — none.

> 💡 **Tips & Tricks**
>
> 25 built-in personalities: from professional modes (analyst, architect, reviewer, debugger, security, performance) to fun modes (pirate, kawaii, noir, philosopher, hype).
>
> Use `/personality list` to see all available options.
>
> The active personality persists across sessions via `SOUL.md`.

> 🎯 **Try it yourself**
>
> `/personality list`
>
> `/personality pirate`
>
> `/personality concise`
>
> `/personality reset`
>
> `Switch to the "mentor" personality, then explain what a Zettelkasten is in that style`

---

## zettelkasten

Maintain a Luhmann-style Zettelkasten with fleeting notes, permanent notes,
cross-references, and structure notes.

**Prerequisites** — none (pure markdown on disk).

> 💡 **Tips & Tricks**
>
> Notes follow a strict ID scheme: `YYYYMMDD-NNN-slug.md`.
>
> Two reference types: Near (within a strand) and Far (cross-strand surprises).
>
> The skill actively surfaces non-obvious connections and challenges vague ideas.
>
> Periodic review moves dormant notes to archive — nothing is deleted.

> 🎯 **Try it yourself**
>
> `Capture this idea as a fleeting note: "Caching invalidation might benefit from event sourcing"`
>
> `Find cross-strand connections between my notes on "distributed systems" and "team communication"`
>
> `Create a structure note synthesizing everything I've collected on "API design patterns"`
>
> `Process all fleeting notes in my inbox, promote the ones about distributed systems to permanent seeds, find cross-strand connections between them, and update the INDEX`
