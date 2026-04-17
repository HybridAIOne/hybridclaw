---
title: Memory Plugins
description: Overview and comparison of HybridClaw's built-in memory and external memory plugin options.
sidebar_position: 5
---

# Memory Plugins

HybridClaw has a layered memory architecture. The built-in memory system is
always active and handles session transcripts, file-backed notes (`MEMORY.md`,
`USER.md`), semantic recall, and compaction summaries. Memory plugins add
external recall and persistence on top of that foundation.

## How Plugins Layer On Built-In Memory

```text
┌─────────────────────────────────────────────┐
│  Prompt context for each turn               │
├─────────────────────────────────────────────┤
│  Built-in memory (always active)            │
│  ├── MEMORY.md, USER.md, daily notes        │
│  ├── SQLite session transcript              │
│  ├── Semantic recall                        │
│  └── Compaction summaries                   │
├─────────────────────────────────────────────┤
│  Memory plugin (optional, one at a time*)   │
│  ├── Prompt-time recall injection           │
│  ├── Model tools for search/write           │
│  └── Background curation / sync             │
└─────────────────────────────────────────────┘

* Plugins marked memoryProvider: true are exclusive —
  only one can be active. Additive plugins can run
  alongside any configuration.
```

## Exclusive vs Additive Plugins

Plugins declare one of two integration modes:

- **Exclusive** (`memoryProvider: true`): replaces the external memory slot.
  Only one exclusive plugin can be active at a time. Built-in memory remains
  active. ByteRover and Honcho use this mode.
- **Additive**: layers additional recall alongside built-in memory and any
  active exclusive plugin. MemPalace, QMD, and GBrain use this mode.

## Comparison

| Plugin | Integration | Storage | Local | Cloud | Auto-install | API Key | Cost | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Built-in Memory** | Always active | SQLite + markdown files | Yes | No | N/A | No | Free | N/A |
| **ByteRover** | Exclusive | Context Tree (`.brv/`) | Yes (default) | Optional sync | Yes (`npm`) | Optional (`BRV_API_KEY`) | Free local, paid cloud | `/byterover` |
| **Honcho** | Exclusive | Cloud API / self-hosted | Yes (self-hosted) | Managed cloud | No binary needed | Yes (`HONCHO_API_KEY`) | $100 free credits, no card | `/honcho` |
| **MemPalace** | Additive | ChromaDB + SQLite | Yes (only mode) | No | Yes (`pip`) | No | Free | `/mempalace` |
| **QMD** | Additive | Local markdown index | Yes (only mode) | No | Manual | No | Free | `/qmd` |
| **GBrain** | Additive | PGLite / Supabase | Yes (PGLite) | Supabase | Manual | `OPENAI_API_KEY` for embeddings | Free local, Supabase costs | `/gbrain` |

## Choosing A Plugin

### Built-in memory (no plugin)

The default. Good enough for most workflows. Handles session history,
file-backed durable notes, semantic recall, and compaction summaries out of the
box with zero setup.

### ByteRover

Best for **structured, project-scoped knowledge**. ByteRover organizes memory
into a hierarchical Context Tree (Domains > Topics > Context Files) stored as
human-readable markdown in `.brv/context-tree/`. The tree is git-friendly and
can be version-controlled. Works fully offline by default with optional cloud
sync.

- Install: `npm install -g byterover-cli`
- [ByteRover Memory Plugin docs](byterover-memory-plugin.md)

### Honcho

Best for **cross-session user modeling and reasoning**. Honcho builds evolving
peer representations of users and agents, supports dialectic reasoning, and
extracts conclusions through continuous background "dreaming." Cloud-managed
with generous free tier ($100 credits, no card required) or self-hostable.

- Install: no binary needed, just an API key
- [Honcho Memory Plugin docs](honcho-memory-plugin.md)

### MemPalace

Best for **local-first, privacy-focused memory** with zero API costs. Uses the
ancient memory palace mnemonic as its organizational metaphor (Wings > Rooms >
Drawers). All embeddings are computed locally via Sentence Transformers.
Optionally exposes 19 MCP tools for taxonomy, knowledge graph, and diary
features.

- Install: `pip install mempalace`
- [MemPalace Memory Plugin docs](mempalace-memory-plugin.md)

### QMD

Best for **searching an existing markdown corpus**. QMD indexes local markdown
files, docs, and optionally exported session transcripts. Lightweight plugin
with lexical, vector, and hybrid retrieval modes. Good when you already have a
well-organized markdown knowledge base.

- Install: external `qmd` CLI
- [QMD Memory Plugin docs](qmd-memory-plugin.md)

### GBrain

Best for **world knowledge and research** — people, companies, meetings,
concepts, and notes organized in a dedicated brain repo. Supports local PGLite
or remote Supabase backends. Mirrors the GBrain tool catalog as `gbrain_*`
plugin tools for read/write operations.

- Install: `bun add -g github:garrytan/gbrain`
- [GBrain Plugin docs](gbrain-plugin.md)

## Multiple Plugins

You can combine one exclusive plugin with any number of additive plugins. For
example:

- **Honcho + GBrain**: Honcho handles user modeling and session continuity
  while GBrain provides world knowledge recall
- **ByteRover + MemPalace**: ByteRover handles structured project knowledge
  while MemPalace adds local search over historical conversations

You cannot run two exclusive plugins (ByteRover + Honcho) at the same time.
