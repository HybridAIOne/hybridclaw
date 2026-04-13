---
title: Memory
description: Built-in HybridClaw memory layers, prompt injection paths, compaction, and default limits.
sidebar_position: 4
---

# Memory

HybridClaw's built-in memory is layered. Different stores solve different
problems:

- `MEMORY.md` is curated long-term workspace memory
- `memory/YYYY-MM-DD.md` is today's raw memory intake
- raw session messages preserve the current conversation
- `session_summary` compresses older current-session history
- semantic memory stores query-recallable interaction summaries
- canonical memory preserves cross-session and cross-channel continuity

On a normal turn, HybridClaw does not inject every stored artifact wholesale.
Some layers are loaded through the bootstrap prompt, some are injected through
the memory hook, and some remain storage-only until a later consolidation or
recall step.

## At A Glance

```text
user turn
  |
  +--> raw session messages ------------------------------+
  |                                                      |
  |                                                      v
  |                                            recent history in prompt
  |                                            older history -> compaction
  |                                                      |
  |                                                      v
  |                                               session_summary
  |                                                      |
  |                                                      v
  |                                                memory hook
  |
  +--> semantic memory ("User asked ... I responded ...")
  |                                                      |
  |                                                      v
  |                                         query-matched semantic recall
  |                                                      |
  |                                                      v
  |                                                memory hook
  |
  +--> canonical cross-channel log ----------------------+
  |                                                      |
  |                                                      v
  |                               canonical summary + recent other-session recall
  |                                                      |
  |                                                      v
  |                                                memory hook
  |
  +--> memory tool / pre-compaction memory flush ------> memory/YYYY-MM-DD.md
                                                         (today only)
                                                                |
                                                                v
                                               bootstrap hook loads today's file
                                                                |
                                                   nightly dream / /dream rewrites
                                                                |
                                                                v
                                                            MEMORY.md
                                                                |
                                                                v
                                             bootstrap hook loads MEMORY.md
```

## Prompt-Time View

On a standard built-in-memory turn, HybridClaw assembles memory from three main
places:

1. Bootstrap files
   This includes `MEMORY.md` and today's `memory/YYYY-MM-DD.md` note when it
   exists.
2. Memory hook
   This includes canonical cross-channel context, the current session summary,
   and relevant semantic recall.
3. Recent raw history
   Recent session messages are passed as normal chat history messages, not as a
   summary block.

That means `MEMORY.md` and today's daily note are not the same thing as the
semantic DB or the current session summary. They enter the prompt through
different paths and follow different update rules.

## The Memory Layers

### `MEMORY.md`

`MEMORY.md` is the curated long-term memory file in the agent workspace.
HybridClaw loads it as part of the bootstrap prompt on every normal turn.

Important properties:

- it is prompt-time context, not a database row
- it is meant to stay curated and relatively stable
- normal `memory` tool writes should not append to it directly
- `/dream` and the scheduled consolidation pass rewrite it from older daily
  notes

Use `MEMORY.md` for durable, cleaned-up context that should persist across
sessions without carrying all raw intake forever.

### `memory/YYYY-MM-DD.md`

This is the raw daily memory intake file.

Important properties:

- the `memory` tool appends here
- the pre-compaction memory flush writes here before older history is
  summarized away
- only today's daily note is injected into the prompt
- older daily notes are not loaded directly once they are no longer "today"
- older daily notes are later folded into `MEMORY.md` during dream
  consolidation

This is the staging area between "the model noticed something worth keeping"
and "the workspace has a cleaned-up long-term memory file."

### Raw Session History

Raw session history lives in the SQLite messages table.

Important properties:

- recent raw turns are passed directly in the conversation history
- HybridClaw keeps only a bounded recent slice for prompt assembly
- that slice is further compressed by character limits before sending
- older turns are eventually compacted out of raw history

This is the highest-fidelity memory for the current session, but it is the
least durable because it is the first thing that gets compacted.

### `session_summary`

When the current session gets large enough, HybridClaw compacts older messages
into `session_summary` and deletes those older raw rows from the active session
history.

Important properties:

- it belongs to the current session only
- it summarizes older turns that were compacted away
- it is injected through the memory hook under `## Session Summary`
- it decays by age and can eventually be dropped when confidence falls too low

This is the bridge between short-term raw history and long-lived workspace
memory files.

### Semantic Memory DB

Semantic memory is stored in SQLite separately from raw messages.

On each normal built-in-memory turn, HybridClaw stores one episodic semantic
memory for the completed interaction, roughly:

```text
User asked: ...
I responded: ...
```

Compaction can also store semantic summary memories.

Important properties:

- semantic memories are query-matched, not always injected
- prompt assembly recalls only a small top-N set
- recalled rows update their access metadata, so recall is stateful
- stale rows decay during dream consolidation

This is the main built-in retrieval layer for "older but still relevant"
context.

### Canonical Cross-Channel Memory

Canonical memory is the cross-session and cross-channel continuity layer keyed
by `(agentId, userId)`.

After each turn, HybridClaw appends the exchange to the canonical log for that
user. At prompt time, it can inject:

- a compacted canonical summary
- a recent window of messages from other sessions or channels for the same user

Important properties:

- it is separate from the current session's raw history
- it is meant for continuity across channels, not only within one thread
- prompt assembly excludes the current session from this recall so it does not
  duplicate the main history window

If a user talks to the same agent in Discord, web chat, and TUI, this is the
layer that helps those sessions remember each other.

## Normal Turn Lifecycle

The built-in path for a successful turn is roughly:

1. Store the user and assistant messages in the session message log.
2. Store one semantic memory for the completed interaction.
3. Append the same exchange to canonical cross-channel memory.
4. On the next turn, load bootstrap files including `MEMORY.md` and today's
   daily note.
5. Build the memory hook from canonical context, `session_summary`, and
   semantic recall.
6. Include recent raw session history as chat messages.
7. When thresholds are exceeded, run pre-compaction memory flush, write a new
   `session_summary`, and delete older raw messages.
8. On `/dream` or the scheduled consolidation run, fold older daily notes into
   `MEMORY.md` and decay stale semantic memories.

## Inspecting And Querying Live Memory

For local diagnostics, HybridClaw exposes:

```text
/memory inspect [sessionId]
/memory query <query>
hybridclaw gateway memory inspect [sessionId]
```

These commands are local-only because they print internal memory state.

`/memory inspect [sessionId]` reports:

- the current workspace `MEMORY.md` file
- today's `memory/YYYY-MM-DD.md` note in the workspace timezone
- recent raw session history and the transcript mirror path
- the stored `session_summary`, compaction count, and last memory flush time
- recent semantic-memory rows stored for the session
- canonical cross-session scope plus the prompt-time cross-channel recall view

`/memory query <query>` shows the exact built-in prompt-memory block the
current session would attach for that query, including:

- whether the stored `session_summary` would be included
- which semantic recalls would attach and their `[mem:n]` citations
- the final attached block exactly as prompt assembly would format it

The query command is a read-only diagnostic: it mirrors prompt assembly without
updating semantic recall access metadata.

Use these commands when you need to explain why HybridClaw answered with
certain prior context, or when you want to verify which memory layer is missing
something.

## Defaults, Caps, And Thresholds

The values below describe the built-in defaults in the current codebase.

### Bootstrap File And Daily Note Caps

| Limit | Default | Meaning |
| --- | ---: | --- |
| bootstrap file read cap | `20,000` chars per file | `MEMORY.md` and other bootstrap files are trimmed before prompt assembly |
| daily note prompt load | today only | only `memory/YYYY-MM-DD.md` for the current date is injected |

### Recent Session History

| Limit | Default | Meaning |
| --- | ---: | --- |
| recent history fetch window | `40` messages | max recent non-silent messages loaded into prompt history |
| history char budget | `24,000` chars | total char budget after history optimization |
| per-message history cap | `1,200` chars | each history message is bounded before budgeting |
| protected head messages | `4` | oldest messages kept during middle compression |
| protected tail messages | `8` | newest messages kept during middle compression |

### Session Compaction

| Limit | Default | Meaning |
| --- | ---: | --- |
| compaction enabled | `true` | current-session compaction runs automatically |
| message-count trigger | `200` messages | compaction can trigger on message volume alone |
| token budget | `100,000` estimated tokens | base compaction budget |
| trigger ratio | `0.7` | compaction triggers at about `70,000` estimated tokens |
| keep recent after compaction | `40` messages | recent raw turns retained after older rows are summarized |
| summary max size | `8,000` chars | `session_summary` is truncated to this size |
| compaction source transcript | `240` messages / `80,000` chars | max older-history excerpt sent into the compaction summary prompt |

### Pre-Compaction Memory Flush

| Limit | Default | Meaning |
| --- | ---: | --- |
| memory flush enabled | `true` | run a memory-writing pass before compaction |
| flush source window | `80` messages | max older messages shown to the memory flush turn |
| flush source cap | `24,000` chars | max transcript chars shown to the memory flush turn |

### Semantic Memory

| Limit | Default | Meaning |
| --- | ---: | --- |
| semantic write cap | `1,200` chars | stored semantic memory content is normalized and truncated to this size |
| prompt recall default | `5` memories | normal prompt assembly asks for up to five semantic matches |
| prompt recall hard cap | `12` memories | `buildPromptMemoryContext()` clamps prompt injection to at most `memory.semanticPromptHardCap` memories |
| low-level recall hard cap | `50` memories | lower-level semantic recall API maximum for non-prompt callers |
| embedding provider | `hashed` | `memory.embedding.provider` selects the semantic vector source: the built-in hashed fallback or a local Transformers.js model |
| Transformers.js model | `onnx-community/embeddinggemma-300m-ONNX` | `memory.embedding.model` controls the Hugging Face model id when the Transformers.js provider is enabled |
| Transformers.js revision | `75a84c732f1884df76bec365346230e32f582c82` | `memory.embedding.revision` pins the exact Hugging Face model revision downloaded on first use |
| Transformers.js dtype | `q8` | `memory.embedding.dtype` selects the local ONNX quantization variant (`fp32`, `q8`, or `q4`) |
| query prep mode | `no-stopwords` | `memory.queryMode` can keep the raw query or strip common stopwords before recall |
| recall backend | `hybrid` | `memory.backend` selects cosine retrieval, full-text BM25 retrieval, or a hybrid fusion of both |
| rerank mode | `bm25` | `memory.rerank` can BM25-rerank the chosen candidate set before the final prompt slice |
| tokenizer | `porter` | `memory.tokenizer` selects the SQLite FTS tokenizer used for lexical matching: `unicode61`, `porter`, or `trigram` |
| semantic min confidence | `0.2` | rows below this are not recalled by default |
| semantic decay rate | `0.1` | nightly decay multiplies stale confidence by `0.9` |
| semantic stale threshold | `7` days | only memories not accessed for at least seven days are decayed |
| semantic decay floor | `0.1` | nightly decay never pushes confidence below this floor |

If you enable `memory.embedding.provider = "transformers"`, the first cosine
query will download and cache the configured ONNX model under
`~/.hybridclaw/cache/transformers`. Gated Hugging Face models follow the
standard `HF_TOKEN` / `HF_ACCESS_TOKEN` environment variables supported by
Transformers.js.

### Session Summary Decay

| Limit | Default | Meaning |
| --- | ---: | --- |
| summary decay rate | `0.04` | summary confidence decays by age before prompt injection |
| summary min confidence | `0.1` | minimum decayed summary confidence |
| summary discard threshold | `0.22` | summaries below this confidence are omitted from the prompt |

### Canonical Cross-Channel Memory

| Limit | Default | Meaning |
| --- | ---: | --- |
| canonical storage window | `50` messages | recent canonical messages kept before another compaction cycle |
| canonical compaction threshold | `100` messages | canonical summary refresh can trigger after this many stored messages |
| canonical summary cap | `4,000` chars | max size of compacted canonical summary |
| canonical message cap | `220` chars | each canonical message is shortened before summary building |
| prompt fetch window | `12` messages | prompt-time canonical recall window before excluding current session |
| prompt display window | `6` messages | only the last six canonical messages are rendered into the prompt section |

### Dream Consolidation

| Limit | Default | Meaning |
| --- | ---: | --- |
| scheduled interval | `24` hours | default nightly consolidation cadence |
| disable scheduled runs | `0` hours | disables automatic consolidation |
| consolidation language | `en` | language hint for model-backed cleanup passes |
| semantic decay rate source | `memory.decayRate` | scheduled consolidation reuses this runtime config value |

## What Operators Can Tune

These areas are explicitly configurable:

- `sessionCompaction.tokenBudget`
- `sessionCompaction.budgetRatio`
- `sessionCompaction.threshold`
- `sessionCompaction.keepRecent`
- `sessionCompaction.summaryMaxChars`
- `sessionCompaction.preCompactionMemoryFlush.*`
- `memory.decayRate`
- `memory.consolidationIntervalHours`
- `memory.consolidationLanguage`

These commonly noticed caps are currently code defaults rather than normal
operator config:

- bootstrap file cap of `20,000` chars
- recent prompt history fetch window of `40` messages
- prompt-time semantic recall hard cap of `12`
- prompt-time canonical fetch window of `12`

## Plugin Caveat

This page describes HybridClaw's built-in memory layer.

If a plugin declares that it replaces built-in memory behavior, the gateway can
skip parts of the native memory injection and compaction flow. Plugins that
layer on top of native memory, such as additive external memory providers, do
not change the built-in behavior described above unless they explicitly replace
it.
