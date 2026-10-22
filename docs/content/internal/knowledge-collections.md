---
title: Knowledge Collections — Company Wiki as Retrieval Background
description: Implementation plan for a file-based, LLM-curated company knowledge base (Karpathy "LLM wiki" shape) that HybridClaw indexes and consults on every turn. Phase 1 ships a usable knowledge-management tool without access control; the early decisions are chosen so agent- and principal-scoped ACLs can be added later without a rewrite.
---

> **Internal document.** Drafted 2026-10-22 on branch `hackathon/reliability-quickwins`. Implements roadmap rows **R47** (agent-/skill-scoped knowledge collections) and the local half of **R7** (shared enterprise memory), and prepares for **R58** (shared workspaces) and **R14** (RBAC). Where this document and the roadmap sketch differ, this document wins. Code anchors verified against this repo on the drafting date.

# Knowledge Collections — Company Wiki as Retrieval Background

## 1. Goal

Give an installation a place to accumulate **company knowledge** as markdown that the agent itself curates (ingest → entities/concepts/analyses pages → index), and make that knowledge available as **background context on every turn** — a RAG layer that sits next to the existing episodic memory rather than inside it.

Two constraints shape the plan:

1. **Phase 1 must be useful on its own**: an operator can create a collection, feed it documents, let the agent build the wiki, and get wiki-grounded answers — with no access-control configuration at all.
2. **Nothing in Phase 1 may make access control hard later.** Section 3 lists the decisions that are locked now for that reason. Everything else is free to change.

Out of scope here: a user-account system for chat users. The knowledge layer *consumes* a principal + assurance pair (section 6); producing a trustworthy one across channels is R14's job.

## 2. What already exists

| Piece | Where | Use in this plan |
|---|---|---|
| Karpathy-style wiki skill: `raw/`, `wiki/{sources,entities,concepts,analyses}/`, `AGENTS.md` schema, `index.md`, `log.md`, ingest/query/lint workflows | [`skills/llm-wiki/SKILL.md`](../../../skills/llm-wiki/SKILL.md), [`skills/llm-wiki/templates/`](../../../skills/llm-wiki/templates/) | The on-disk shape of a collection. Reused as-is; the skill learns to target a configured collection root. |
| Chunker, embedding providers (`hashed`, Transformers.js), FTS5 + cosine + hybrid recall, BM25 rerank | [`src/memory/chunk.ts`](../../../src/memory/chunk.ts), [`src/memory/embeddings.ts`](../../../src/memory/embeddings.ts), [`src/memory/semantic-memory.ts`](../../../src/memory/semantic-memory.ts), [`src/memory/semantic-recall.ts`](../../../src/memory/semantic-recall.ts) | The retrieval engine. Reused; **no new vector store** (R7). |
| `MemoryLayerPlugin.getContextForPrompt({sessionId, userId, agentId, workspacePath, recentMessages})` → injected as `retrievedContext` | [`src/plugins/plugin-types.ts:411`](../../../src/plugins/plugin-types.ts#L411), [`src/plugins/plugin-manager.ts:1955`](../../../src/plugins/plugin-manager.ts#L1955), [`src/gateway/gateway-chat-service.ts:1845`](../../../src/gateway/gateway-chat-service.ts#L1845) | The per-turn injection hook. Already carries the principal fields we need. |
| `plugins/qmd-memory` — external-CLI precedent for "search a markdown corpus, inject ≤4 k chars" | [`plugins/qmd-memory/src/index.js`](../../../plugins/qmd-memory/src/index.js) | Budget and snippet-format precedent. Not a dependency. |
| Extra mounts `container.binds` → `/workspace/extra/<name>`, allowlist-checked | [`src/security/mount-security.ts`](../../../src/security/mount-security.ts), [`container/src/runtime-paths.ts`](../../../container/src/runtime-paths.ts) | Mechanism for exposing a collection read-only inside the sandbox. |
| Container → gateway tool bridge `POST /api/plugin/tool` (passes `sessionId`, `channelId`) | [`src/gateway/gateway-http-server.ts:11281`](../../../src/gateway/gateway-http-server.ts#L11281), `PluginToolHandlerContext` | Pattern for a host-executed `knowledge_search` tool. The container has **no** direct access to the host SQLite DB. |
| Scheduler jobs (`agent_turn`, `system_event`, `heartbeat_poll`), nightly consolidation runner | [`src/scheduler/scheduler.ts`](../../../src/scheduler/scheduler.ts), [`src/memory/consolidation-runner.ts`](../../../src/memory/consolidation-runner.ts) | Model for the nightly maintenance job. |
| Audit: `recordAuditEvent` with free-form `type`, `actor {type,id}`, `authorization.check {action, resource, allowed, reason}` | [`src/audit/audit-events.ts`](../../../src/audit/audit-events.ts), [`src/memory/audit.ts:112`](../../../src/memory/audit.ts#L112) | Knowledge events need no schema change. |
| Admin RBAC actions + role bundles; API tokens with claims | [`src/security/admin-rbac.ts`](../../../src/security/admin-rbac.ts), [`src/security/api-tokens.ts`](../../../src/security/api-tokens.ts) | Where `admin.knowledge.*` actions go. |
| Identity primitives: canonical user id `user@authority`, `Actor`, `sessionRouting.identityLinks` (`"<channelKind>:<peerId>"` aliases) | [`src/identity/`](../../../src/identity/), [`src/session/session-routing.ts`](../../../src/session/session-routing.ts) | The only cross-channel principal mapping today. |

Gaps the plan has to close: nothing injects a wiki into the prompt; recall is keyed by `session_id` with no corpus dimension; no shared folder between agents besides a shared `workspace` id; uploads expire after 24 h; the revision asset type `'knowledge'` is already taken by `src/distill/corpus.ts`.

## 3. Decisions locked in Phase 1 (so ACLs stay cheap later)

These are the choices that would be expensive to reverse. Everything not listed here is a Phase 1 detail and may change.

**D1 — Collections live outside every agent workspace.**
Root: `<DATA_DIR>/knowledge/<collection-id>/` (default `~/.hybridclaw/data/knowledge/…`). A collection is exposed to an agent by **mounting** it, never by copying into `workspace/`. Rationale: anything inside the workspace is readable via `read`/`grep`/`bash`, so a retrieval-level ACL on workspace files would be theatre. Keeping the files outside means "revoke access" is "do not mount" — one mechanism, enforced by the sandbox.

**D2 — The collection is the unit of scope and the stable key.**
Every chunk row, every audit event, every tool call and every config entry carries a `collection_id` (`^[a-z0-9][a-z0-9-]{1,62}$`). Finer-grained page access is expressed later as a *filter* on indexed frontmatter (D7), never as a second scoping system.

**D3 — Exactly one search entry point, with scope as a required parameter.**
`searchKnowledge({ query, scope, limit, budgetChars })` where `scope.collectionIds: string[]` is mandatory (an empty array returns nothing). Phase 1 callers pass "all collections bound to this agent". Later phases pass the result of an ACL resolver. There is no code path that searches "everything".

**D4 — The request context carries the principal from day one.**
```ts
interface KnowledgeRequestContext {
  agentId: string;
  sessionId: string;
  channelKind: string;          // 'web' | 'telegram' | 'email' | …
  principal: { userId: string; canonicalUserId?: string };
  assurance: 'any' | 'allowlisted' | 'authenticated';
}
```
Phase 1 fills `assurance` with a trivial resolver (`web` session cookie or API token → `authenticated`, everything else → `any`) and **does not act on it**, but writes it into every `knowledge.query` audit event. When Phase 3 adds `minAssurance` to a collection, the data to decide is already flowing and already auditable.

**D5 — Mounts are read-only; writes go through one host-side tool.**
The agent never gets `rw` on a collection. Curation writes (`wiki/**`, `index.md`, `log.md`) go through `knowledge_write`, executed on the host via the plugin-tool bridge, which checks `write.agents` (Phase 1: any bound agent) and appends the `log.md` entry itself. Rationale: a write ACL later is a one-line check in one function; an `rw` mount would mean re-educating the skill and auditing nothing. Raw-source ingest (`raw/**`) also goes through the host (`/knowledge add`, section 5), so the 24 h upload TTL is irrelevant.

**D6 — Own index table, not `semantic_memories`.**
`knowledge_chunks` is keyed by `(collection_id, path, chunk_index)` with `content_hash`, `heading_path`, `page_type`, `frontmatter` (JSON), `embedding`, `indexed_at`, plus an FTS5 shadow table. Rationale: knowledge is file-derived, re-indexable, has no decay/confidence/access-count lifecycle and no `session_id`. Sharing the episodic table would force a `source` discriminator into every existing recall query. The *engine* (chunker, embedding provider, hybrid rank fusion) is shared; the *table* is not.

**D7 — Frontmatter is indexed as metadata.**
The `llm-wiki` template already defines `title, created, updated, type, tags, sources`. The indexer stores the full frontmatter as JSON per chunk and reserves the key `access` (free-form object, unused in Phase 1). Page-level restrictions later become a WHERE clause, not a re-index.

**D8 — Audit from the first turn.**
Events (all with `actor` and `collectionIds`):
- `knowledge.query { collectionIds, assurance, resultCount, injected: boolean, budgetChars }`
- `knowledge.source_used { collectionId, path, headingPath, score }` — one per injected snippet
- `knowledge.write { collectionId, path, bytes, reason }`
- `knowledge.ingest { collectionId, source, path }`
- `authorization.check { action: 'knowledge.read'|'knowledge.write', resource: 'knowledge:<id>', allowed, reason }` — Phase 1 always `allowed: true`, but emitted, so dashboards and the audit CLI need no change later.

**D9 — Config shape reserves the ACL object.**
```jsonc
"knowledge": {
  "enabled": true,
  "root": null,                       // default <DATA_DIR>/knowledge
  "index": { "embeddings": "inherit", "maxChunkChars": 1200, "reindexIntervalMinutes": 30 },
  "inject": { "maxChars": 4000, "maxSnippets": 6, "minScore": 0.25 },
  "collections": [
    {
      "id": "company-handbook",
      "title": "Company handbook",
      "access": {                     // Phase 1: optional; default = every agent, principals "*"
        "agents": ["main", "sales"],
        "principals": ["*"],
        "minAssurance": "any"
      },
      "write": { "agents": ["main"] } // Phase 1: default = access.agents
    }
  ]
}
```
Per-agent binding mirrors `skills: string[]`: `AgentConfig.knowledge?: string[]` (DB column + serializer + fingerprint, like `tools`/`skills`). `access.agents` on the collection and `knowledge` on the agent must agree; the resolver takes the intersection and logs a config warning on mismatch.

**D10 — Namespace.** The revision asset type `'knowledge'` belongs to distill. Collection snapshots use `'knowledge-collection'`. Tool names are `knowledge_search`, `knowledge_write`; the slash command is `/knowledge`; the mount prefix is `/workspace/knowledge/<id>/`.

**D11 — No hard dependency on external binaries.** `qmd` stays an optional plugin. The built-in path must work with the `hashed` embedding provider and FTS5 alone.

## 4. Target architecture

```
                      ┌──────────────────────────────────────────┐
  operator / channels │  gateway (host)                          │
  ───────────────────▶│  /knowledge add ─▶ ingest ─▶ raw/        │
                      │  scheduler: knowledge.maintain (nightly) │
                      │                                          │
                      │  src/knowledge/                          │
                      │   manifest.ts   collections + bindings   │
                      │   indexer.ts    md ─▶ chunks ─▶ sqlite   │
                      │   search.ts     hybrid recall, scoped    │
                      │   access.ts     resolveScope(ctx) ──┐    │
                      │   memory-layer.ts  getContextForPrompt   │  (D3/D4)
                      │   tools.ts      knowledge_search/write   │
                      │   audit.ts      D8 events                │
                      └───────────┬───────────────▲─────────────┘
                 read-only mount  │               │ /api/plugin/tool
                                  ▼               │
                      ┌──────────────────────────────────────────┐
                      │  agent sandbox                           │
                      │  /workspace/knowledge/<id>/  (ro)        │
                      │   AGENTS.md index.md log.md raw/ wiki/   │
                      │  llm-wiki skill: orient / ingest / query │
                      │  grep · read   (Karpathy path)           │
                      │  knowledge_search · knowledge_write      │
                      └──────────────────────────────────────────┘
```

Two retrieval paths coexist on purpose:

- **Karpathy path** (agent-driven): the skill reads `index.md`, greps `wiki/`, follows links. Cheap, transparent, works with zero index. Bounded by the mount, i.e. by agent-level access.
- **Background path** (host-driven): the memory layer runs `searchKnowledge` with the last user message before every turn and injects top-k snippets with source tags `[knowledge:<id>/wiki/concepts/pricing.md#tiers]`. This is the only path that can honour principal-level access, because it runs where the request context is known.

Ranking prefers `wiki/` over `raw/` (page_type weight: `analysis`/`concept`/`entity` > `source` > raw), so the agent gets compiled knowledge first and raw fragments only when nothing curated matches.

## 5. Phases

### Phase 1 — usable KM tool, no ACL (this branch or next)

Deliverable: an operator defines a collection, the agent builds and maintains the wiki, every turn of a bound agent is wiki-grounded, everything is audited.

1. **Config + migration** — `knowledge` block in `RuntimeConfig` (`src/config/runtime-config.ts`, defaults next to `memory`, normalizer, `CONFIG_VERSION` 38→39, `config.example.json`), `AgentConfig.knowledge`, DB migration for `knowledge_chunks` + FTS5 + `knowledge_collections` (id, title, root, created_at, last_indexed_at, doc_count).
2. **Collection bootstrap** — `hybridclaw knowledge init <id>` / admin create: makes `<root>/<id>/` from `skills/llm-wiki/templates/`, registers it.
3. **Mount** — bound collections appear at `/workspace/knowledge/<id>/` read-only via the existing binds path (allowlist entry written automatically for `<DATA_DIR>/knowledge/**`). `safeJoin` and `workspace_fence` already understand extra roots.
4. **Indexer** — walks `wiki/**/*.md` and `raw/**/*.md|txt`, parses frontmatter, chunks with `chunkMessage`, embeds with the configured provider, upserts by `content_hash`, deletes vanished paths. Runs at startup, on `knowledge_write`/ingest, and on the `reindexIntervalMinutes` timer.
5. **Search + memory layer** — `searchKnowledge` (hybrid: FTS5 candidates → cosine → BM25 rerank, reusing the fusion code in `semantic-memory.ts` by extraction into a shared helper), built-in `MemoryLayerPlugin` with `priority` below qmd-memory, budgeted injection, `knowledge.query`/`source_used` events.
6. **Tools** — `knowledge_search` (explicit, with optional `collection`) and `knowledge_write` (path under `wiki/`, `index.md` or `log.md`; rejects `raw/`), both executed host-side via the plugin-tool bridge pattern; host resolves `agentId` from the session (the bridge only passes `sessionId`/`channelId` — see §7).
7. **Ingest** — `/knowledge add <id> <url|@file|@folder>` and `POST /api/admin/knowledge/:id/ingest` copy sources into `raw/` with a sidecar `*.meta.json` (origin, fetched_at, actor) and enqueue an `agent_turn` for the bound agent: "Ingest `raw/<file>` following AGENTS.md". Email/Brevo attachment → `raw/inbox/` is a follow-up.
8. **Maintenance job** — scheduler job `knowledge.maintain` (default nightly, per collection): reindex, then an `agent_turn` running the skill's lint workflow with a report written to `wiki/analyses/lint-<date>.md`.
9. **Skill update** — `llm-wiki` SKILL.md: when `/workspace/knowledge/<id>/` exists, treat it as the wiki root, use `knowledge_write` for all writes, mention `knowledge_search` in the query workflow. Keep the skill working standalone for installations without the feature.
10. **Docs** — operator guide `docs/content/guides/knowledge-collections.md`, config reference entries, memory developer guide section.

### Phase 2 — hard agent scoping + admin surface

- `access.agents` enforced: unbound agents get no mount and `searchKnowledge` scope excludes the collection (D3 makes this a resolver change only).
- Admin routes `/api/admin/knowledge/*` (list, create, index status, browse tree, read page, trigger reindex/ingest) with RBAC actions `admin.knowledge.read|write|manage` in `ADMIN_RBAC_ACTIONS` and role bundles; console page with tree browser + page viewer (the current editor allowlist in `gateway-service.ts:741` does not cover a tree).
- `knowledge-collection` revision snapshots so a bad curation run is reversible (same pattern as distill's corpus revisions).
- `audit-cli` filter for `knowledge.*`; `gateway-agent-cards.ts` surfaces "knowledge used" per turn.

### Phase 3 — principal-scoped access

- `access.principals` + `minAssurance` enforced in `resolveScope`. Principal resolution: `identityLinks` alias (`"<channelKind>:<peerId>"`) → canonical id; fallback to the raw `(channelKind, userId)` pair. Assurance resolver reads the gateway auth context (`master`/`apiToken`/`session` → `authenticated`; channel allowlist hit → `allowlisted`; else `any`).
- Collections with any principal restriction are **never mounted** (D1/D5): they are reachable only through the background path and `knowledge_search`, which both carry the request context. The skill's orient step lists them as "search-only".
- Denials emit `authorization.check { allowed: false }` and are visible in the existing audit tooling.
- Depends on R14 for roles; until then `principals` is a flat list of ids/aliases plus `"*"`.

### Phase 4 — quality and reach

- Retrieval eval suite (R47.7 / R7d): golden questions per collection, hit@k on `source_used`.
- Optional cloud sync of `index.md` + `wiki/` summaries through the existing `cloud-memory` channel for `company`-scope sharing across installations.
- R58 shared workspaces may adopt the same mount + ACL resolver.

## 6. Access model (for reference; enforced from Phase 2/3)

| Axis | Source of truth | Strength | Enforced by |
|---|---|---|---|
| Agent | `collection.access.agents` ∩ `agent.knowledge` | strong (operator-defined) | mount presence + search scope |
| Principal | `collection.access.principals` vs resolved principal | as strong as the channel | search scope only; no mount |
| Assurance | `collection.access.minAssurance` vs request assurance | derived from auth context | search scope only |
| Write | `collection.write.agents` | strong | `knowledge_write` handler |

Honest limits: Telegram/Slack ids are allowlist-gated but unauthenticated; email senders are unverified (no DKIM check in `src/channels/email/inbound.ts`); bearer-API `userId` is client-supplied. Hence `minAssurance: authenticated` is the only setting that should guard genuinely confidential collections until R14 lands.

## 7. Open points and risks

- **Plugin-tool bridge context** — `PluginToolHandlerContext` has `sessionId` and `channelId` only. Host-side resolution of `agentId`/`userId` from the session row is sufficient for Phase 1, but Phase 3 wants the assurance level too; extend the bridge payload (additive) rather than inferring it.
- **`index.md` growth** — the Karpathy path assumes `index.md` fits in context; the bootstrap cap is 20 k chars. The skill's thresholds already split by page family; the maintenance job should warn when `index.md` exceeds ~15 k and suggest per-family indexes.
- **Embedding cost** — `hashed` is free but weak; Transformers.js is local but slow on first load. Phase 1 defaults to `inherit` from `memory.embeddings`; large collections may want a dedicated setting.
- **Concurrent curation** — two agents bound with write access can race on `index.md`. Phase 1: single `write.agents` entry recommended; R65's SHA-based optimistic write is the upgrade path, and `knowledge_write` already centralises the write so a check-and-set is a local change.
- **Brevo attachments** — not persisted today (`plugins/brevo-email/src/brevo-inbound.js`); ingest-from-email needs that first.
- **Multi-collection prompt budget** — several bound collections share one `inject.maxChars`; rank fusion must be collection-agnostic to avoid one noisy collection starving the rest.

## 8. Roadmap mapping

| Roadmap | This plan |
|---|---|
| R47.1 manifest loader | Phase 1 step 1 (config block instead of a `KNOWLEDGE.md` file in the prompt — the catalog is `index.md` inside the mount) |
| R47.2 activation-scoped router | D3 + Phase 2 |
| R47.3 QMD adapter | Not needed; qmd-memory remains optional |
| R47.4 skill-level attachments | Deferred; collections can be bound to agents, skill binding reuses `access` later |
| R47.5 audit events | D8, Phase 1 |
| R47.6 `/knowledge add` | Phase 1 step 7 |
| R47.7 eval | Phase 4 |
| R7 a/b/c | D6 (source dimension via own table), Phase 1 ingest, Phase 2/3 scoping |
| R58 ACL + mount | Same mount/resolver machinery, adopted later |
