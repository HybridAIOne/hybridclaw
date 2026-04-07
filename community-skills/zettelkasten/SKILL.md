---
name: zettelkasten
description: A living idea garden with an active gardener. Capture, connect, and synthesize ideas using Zettelkasten principles but with an AI agent that actively tends the garden, surfaces surprising connections, challenges assumptions, and enriches seeds with research. Use when the user shares an idea, observation, or inspiration; when reviewing or connecting existing notes; when synthesizing patterns; or during heartbeats to tend the garden.
---

# Zettelkasten - The Living Garden

Not an archive. A garden with a gardener.

Luhmann's Zettelkasten was brilliant but inert - it waited for him. Ours
doesn't wait. The agent lives inside it: noticing connections, challenging
ideas, enriching seeds with research, surfacing surprises. Less filing
cabinet, more conversation partner with a memory.

## Storage

All notes in `memory/zettelkasten/`:

- `inbox/` - Raw unprocessed drops (fleeting notes)
- `seeds/` - Processed atomic ideas (permanent notes)
- `connections/` - When 2+ seeds click (Luhmann's Fernverweise made explicit)
- `structures/` - Developed frameworks, plans
- `archive/` - Dormant ideas (never deleted - Luhmann's rule)
- `INDEX.md` - Curated entry points (not a tag dump - each keyword -> best
  starting seed)
- `JOKER.md` - Meta-note: how this specific garden works, its quirks, what's
  growing

## Note Format

```markdown
# [Title]
**ID:** YYYYMMDD-NNN
**Date:** YYYY-MM-DD
**Status:** 🌱 seed | 🌿 growing | 🌳 mature | 🔥 actionable | 💤 dormant
**Tags:** #tag1 #tag2
**Source:** [where it came from]
**Strand:** [parent ID if branching from another note]

## Idea
[The core thought - always in own words, never just a quote]

## Context
[Why this matters, what triggered it]

## References
- **Near** (same strand): [[ID]] - [relationship]
- **Far** (cross-strand): [[ID]] - [why these distant ideas connect]

## Gardener's Notes
[Agent observations, challenges, enrichments added over time]
```

### Naming

- Inbox: `YYYYMMDD-HHMMSS-raw.md` (timestamped, unprocessed)
- Seeds: `YYYYMMDD-NNN-slug.md` (e.g., `20260215-001-next-openclaw.md`)
- Branches: `YYYYMMDD-NNNa-slug.md` (extending a parent: 001a, 001b, 001a1)
- Connections: `YYYYMMDD-CNNN-slug.md`
- Structures: `YYYYMMDD-SNNN-slug.md`

### Reference Types (from Luhmann)

- **Near (Nahverweis):** Within the same strand/argument thread. Red thread
  connections.
- **Far (Fernverweis):** Cross-strand surprises. The magic ones. When an idea
  about memory markets suddenly links to a paper on spatial cognition.

## The Alive Layer

What makes this different from every other Zettelkasten guide:

### 1. Active Gardening (during heartbeats)

Don't just check - tend:

- Re-read seeds >7 days old without connections. Try harder. Research if
  needed.
- Notice contradictions between notes. Flag them - contradictions are where
  ideas grow.
- Enrich seeds: if a raw idea mentioned a concept, look it up, add context to
  Gardener's Notes.
- Update `INDEX.md` when new clusters emerge.
- Update `JOKER.md` with observations about the garden's shape.

### 2. Surprise Delivery

When a non-obvious far connection is found, don't just log it - tell the user.
The best Zettelkasten moments are "holy shit, I never saw that link." Deliver
these proactively.

### 3. Challenge & Provoke

If a new seed contradicts an existing one, say so. If an idea is vague, push
back. The garden grows through friction, not just collection. Add devil's
advocate notes in Gardener's Notes.

### 4. Strand Awareness

Track argument threads across seeds. When a user keeps circling the same theme
(even without realizing it), name the strand. "You've been thinking about
portable identity for 3 weeks across 5 seeds - here's the thread."

### 5. Seasonal Review

Periodically (weekly during heartbeats), write a brief "garden report":

- What's growing (active strands)
- What's dormant (seeds with no connections after 2+ weeks)
- What surprised you (unexpected connections found)
- What's ready to harvest (clusters mature enough to become structures)

## Workflows

### Capture (user drops an idea)

1. If quick/raw -> file in `inbox/` with timestamp
2. If clear enough -> create seed in `seeds/`, rephrase in own words
   (Luhmann's rule)
3. Scan existing seeds for near and far references
4. If it branches from an existing seed, use branching ID (001a)
5. Update `INDEX.md` if it introduces a new concept
6. Confirm capture with one line + any immediate connections spotted

### Process Inbox (during heartbeats or on request)

1. Review `inbox/` items
2. For each: rephrase in own words, decide if it's seed-worthy or discard
3. Promote to `seeds/` with proper format, or leave with a note on why it's
   not ready

### Connect (active gardening)

1. Read seeds, look for clusters - especially cross-strand far connections
2. Create connection note in `connections/` explaining the emergent pattern
3. Update both seeds with back-references
4. If the connection is surprising -> surface it to the user proactively

### Synthesize (when enough seeds cluster)

1. Draft structure in `structures/` referencing all contributing
   seeds/connections
2. Include framework, open questions, and next steps
3. Present to user - this is harvest time

### Prune (on request only)

Move to `archive/` with a note on why. Never delete. Luhmann's rule:
"useless" notes become essential years later.
