---
title: God-Files Refactor Plan
description: Internal plan for splitting the four largest core modules into ~500-line modules. Not linked from the public docs nav.
---

# God-Files Refactor Plan

Status: in progress. Proposed 2026-07-25; progress refreshed 2026-09-27.

Targets, by size:

| File | LOC (2026-07-25) | LOC (2026-09-27) | End-state goal | Progress |
|---|---|---|---|---|
| `src/gateway/gateway-service.ts` | 14,308 | 15,197 | slim command dispatcher + re-export barrel (< 1,500 LOC) | Phase 0 started |
| `src/memory/db.ts` | 11,716 | 38 | connection lifecycle + re-export barrel (< 800 LOC) | done (#1377) |
| `src/gateway/gateway-http-server.ts` | 11,276 | 11,882 | ordered dispatcher + lifecycle (< 2,000 LOC) | not started |
| `src/config/runtime-config.ts` | 9,765 | 10,316 | orchestrator + singleton state + barrel (< 1,500 LOC) | not started |

Order (2026-09-27): `gateway-service.ts` first, as the largest and the most
often edited file (54 commits, +533 net LOC in the prior 30 days).

Source line ranges below are from the 2026-07-25 snapshot. The three open
files have each grown 500–900 lines since, so re-locate every range by
symbol name before moving it.

AGENTS.md sets a ~500 LOC target per file; every extracted module should land at or
near that. All four files already have proven satellite-module patterns in their own
directories — every extraction below copies an existing house pattern rather than
inventing a new one.

---

## Ground rules (all four workstreams)

1. **Move code verbatim.** Each step is a mechanical relocation; behavior, status
   codes, log output, and error envelopes stay byte-identical. Cleanups (dedup,
   generic helpers) are their own commits, never mixed with moves.
2. **Barrel where consumers are many, repoint where few.**
   - `db.ts`: 61 static importers + **77 dynamic `await import()` sites** + a
     `typeof import` namespace binding (`src/audit/audit-cli.ts`) + a whole-module
     `vi.mock` (`tests/session-title.test.ts`) → keep `db.ts` as a permanent
     re-export barrel.
   - `runtime-config.ts`: 161 importers, but 90 % use only `getRuntimeConfig` /
     `RuntimeConfig` / `updateRuntimeConfig` / `runtimeConfigPath` → keep as barrel.
   - `gateway-service.ts`: 6 production consumers but 43 test files import it
     directly → keep re-exports until tests are repointed; repointing
     `gateway-http-server.ts` directly at new modules matches house style (it
     already imports `gateway-admin-secrets.js` etc. directly).
   - `gateway-http-server.ts`: exactly 1 production consumer, 2 exports → no
     barrel needed at all; the split is purely internal.
3. **Don't break test harness mechanics.** Mocks are keyed by module path:
   - Never insert a re-export shim in front of a module that tests `vi.doMock`
     (e.g. `gateway-service.js`, `admin-terminal.ts`, `config/config.js`).
   - Never convert a static import of a mocked module into a dynamic one (or vice
     versa) — also an AGENTS.md rule for production paths.
   - New modules must import the same already-mocked dependency paths; then the
     380-test `gateway-http-server.test.ts` suite and the 43 `gateway-service.*`
     suites keep working untouched and serve as characterization tests.
4. **Import-time side effects stay where they are.** `runtime-config.ts` runs
   `initializeRuntimeConfig()` (disk IO, may rewrite `config.json`) at import; 52
   test files control it via dynamic import + scratch `HOME`. The side effect stays
   in the barrel entry point; extracted schema/normalizer modules must be pure and
   importable without it. Same for `DEV_VITE_URL` (env read + warning at import) in
   the http server.
5. **One PR per phase**, `refactor(scope):` conventional commits, signed off.
   Per PR: `npm run lint`, targeted suites for the moved concern, then full
   `npm run test:unit`, `npm run format`.
6. **De-export before you move.** All four files export symbols nobody imports
   (db: ~23, runtime-config: 73, gateway-service: 3 dead). Narrowing the public
   surface first makes every later move smaller. For db.ts, verify candidates
   against the 77 dynamic-import sites and the `audit-cli.ts` namespace binding
   before removal.

Dependency between workstreams: none hard. `gateway-http-server.ts` imports 83
symbols from `gateway-service.ts`, but route-handler extraction is independent of
where those symbols live as long as import paths resolve (barrel preserved). The
four workstreams can proceed in parallel branches; land Phase-0 cleanups first in
each to avoid rebase pain.

---

## 1. `src/memory/db.ts` (11,716 LOC)

Flat module, no classes, ~200 exports across 19 domains. House pattern already
established: **schema stays centralized in migrations; query stores move out** as
free functions wrapping `withMemoryDatabase` (see `jobs.ts`, `apps.ts`,
`src/board/card-store.ts`).

### Phase 0 — surface shrink (small PR)

- Delete duplicate `nextSchedulerJobSortOrder` (db.ts:4802; `jobs.ts:186` is the
  keeper) by moving the scheduler-job bootstrap (`migrateLegacyTasksToJobsTable`,
  `ensureDefaultSchedulerJobs`, lines 4775–4911) into `jobs.ts`;
  `initDatabase` keeps calling them (bootstrap-ordering dependency).
- Fold `getObservabilityIngestToken` into its caller; de-export the ~23
  unreferenced symbols (after dynamic-import verification).
- Consolidate the duplicate `CompactionCandidate` type (db.ts:9503 vs
  `memory-service.ts:84`).

### Phase 1 — schema extraction (the big win: −3,080 LOC, 26 %)

The migration block (lines 361–3442) never touches the module `db` singleton —
every function takes `database` explicitly — so this is a verbatim move:

- `src/memory/schema/migrations.ts` — `migrateV1`–`migrateV53` + `runMigrations`
  (preserve the V52-gap comment verbatim; the gap is intentional).
- `src/memory/schema/introspection.ts` — `tableExists`, `columnExists`,
  `indexExists`, `getTableSql`, `addColumnIfMissing`, `quoteSqlIdentifier`.
- `src/memory/schema/migration-predicates.ts` — the 21 `*NeedMigration` fns.
- `src/memory/sql-helpers.ts` — `queryOne`/`queryAll` (+ overloads), shared by
  migrations and every query domain. Extract first.

DDL for future tables continues to live here (matches the `jobs`/`apps`/`board`
convention), so later store extractions never need to shard the schema.

### Phase 2 — Tier-1 stores (mechanical, near-zero coupling)

Each becomes a `withMemoryDatabase`-pattern module; db.ts re-exports:

| New module | Source lines | LOC |
|---|---|---|
| `proactive-queue.ts` | 11622–11716 | 95 |
| `delegation-jobs-store.ts` | 11432–11620 (+types 277–301) | ~190 |
| `knowledge-graph.ts` | 6111–6491 | 381 |
| `memory-kv-store.ts` | 4232–4398 | 167 |
| `observability-store.ts` | 11353–11430 | ~80 |
| `skill-scoring.ts` (pure math, no SQL) | 10041–10166 | 126 |
| `embedding-vectors.ts` (pure; companion to `embeddings.ts`) | 8610–8688 | 79 |

**Add characterization tests first** for the currently untested domains:
knowledge graph, KV store, statistics/trends, proactive queue, skill-scoring math.
`delegation-jobs-store.test.ts` already exists.

### Phase 3 — domain stores (larger, needs care)

- `usage-store.ts` (~1,060) — carries the batch-statement cache and the
  `usageRecordSubscribers` Set; `initDatabase` needs an exported
  `resetUsageStatementCache()` hook. Move `normalizeUsageNumber`/`Cost` to a tiny
  shared `usage-normalize.ts` first (stats + messages also use them).
- `statistics-store.ts` (211) — after `usage-normalize.ts` exists.
- `sessions-store.ts` (~1,200) + `recent-sessions.ts` (the self-contained
  summaries engine, 7342–7568, ~227). `resolveSessionIdCompat` /
  `requireSessionById` become exports (messages + `jobs.ts` use them).
- `messages-store.ts` (~760) — including the compaction functions currently
  misfiled in the semantic-memory block (9503–9600), and `response-ratings`
  (~270, has its own test file).
- `semantic-memory-store.ts` (~900) — recall strategies (8783–9215) can go into
  the existing `semantic-recall.ts` family. `memory-service.test.ts` (3,646 LOC)
  is the regression suite; run it every step.
- `skills-store.ts` (~1,000 after scoring left in Phase 2).
- `audit-store.ts` (~610) — structured audit + approvals reads.
- `agents-store.ts` (~340) + `agent-serde.ts` (~400) — serde + canonical-identity
  allocation; needs `withMemoryDatabaseRuntimeRevisionStore` for the attached
  revisions DB.
- `canonical-sessions.ts` (294).

### End state

`db.ts` keeps: connection singleton, `initDatabase` (calling `runMigrations` +
the `jobs.ts` bootstrap + cache-reset hooks), `withMemoryDatabase`,
`withMemoryDatabaseRuntimeRevisionStore`, `ensureDatabaseReady`, and one
re-export block per extracted module. Consumers get repointed opportunistically;
the barrel stays for the dynamic-import long tail.

---

## 2. `src/config/runtime-config.ts` (9,765 LOC)

One god-interface (`RuntimeConfig`, ~55 keys), one 702-LOC defaults literal, one
1,844-LOC `normalizeRuntimeConfig`, ~146 private normalizers, plus singleton
state/watcher/save machinery. House patterns both exist already:
`runtime-config-revisions.ts` (stateful subsystem + aliased facade) and
`runtime-paths.ts` (pure leaf). Domain normalizers already delegate outward in a
dozen cases (`agent-types.js`, discord/slack webhook targets, `model-routing.js`)
— precedent that domain config code belongs next to its domain.

### Phase 0 — surface shrink

- Delete fully dead: `RuntimeSkillScopeConfigDraft/View`,
  `RuntimeToolScopeConfigDraft/View`, `getLastKnownGoodRuntimeAssetMetadata`.
- Un-export the remaining ~70 symbols referenced nowhere else.
- Fold the revisions facade (9531–9729, 22 one-line wrappers) — re-export
  directly from `runtime-config-revisions.js` instead; only 8 files use these.

### Phase 1 — pure leaves (unlocks everything else)

1. `runtime-config-primitives.ts` — `normalizeString/Boolean/Integer/Number/
   StringArray`, `normalizeOptionalBaseUrl`, `hasOwn`, enum-validator helper.
   Every later module imports this; extract first.
2. `runtime-config-types.ts` (~1,180) — all type/interface declarations. Requires
   first converting the ~15 inline `RuntimeConfig` sub-objects (discord, provider
   blocks, container, memory, …) into named interfaces. Key win: the schema
   becomes importable **without** the `initializeRuntimeConfig()` disk-IO side
   effect. `config.ts` uses indexed-access types (`RuntimeConfig['discord'][…]`),
   so naming sub-interfaces is safe but renaming top-level keys is not.
3. `runtime-config-defaults.ts` (702) — `DEFAULT_RUNTIME_CONFIG` + the 16 model
   lists; referenced ~70× inside `normalizeRuntimeConfig`, so it must be
   importable by every domain module.

### Phase 2 — zero-coupling domain extractions

| New module | Source | LOC | Note |
|---|---|---|---|
| deployment/tunnel config | 324–350, 2325–2392 | ~95 | has `runtime-config-deployment.test.ts` — do first as proof of slice |
| `src/scheduler/scheduler-config.ts` | 258–279, 804–830, 4887–5086 | ~250 | already orphaned: no `RuntimeConfig` field, legacy-migration only |
| `src/browser/camofox-config.ts` | 6017–6420 | 404 | also removes the `camoufox-js` import from core config |
| `src/config/http-request-auth-config.ts` | 866–969, 5754–5820 | ~170 | pure OAuth guards currently wedged mid-types |
| ui-navigation | 351–363, 5100–5185 | ~99 | |
| `src/providers/base-url-migrations.ts` | 5292–5351 | 60 | |

### Phase 3 — channels + repetition collapse

- Channel normalizers (3252–4886, 1,635 LOC) → per-channel modules
  (`src/channels/<name>/config.ts`) or one `channel-config.ts` per channel
  family, following the existing `discord-webhook/target.js` precedent. The
  **secret-input round trip is the trap**: `preserve*SecretInputs` (S22) operate
  on raw source JSON at save-time and must move together with their domain's
  normalizer or stay centralized — never split the resolve/preserve pair.
- Separately-committed shrink (not moves): generic `normalizeEnum` replaces ~14
  copies of the same policy validator (~200 LOC); a
  `normalizeSimpleProviderConfig` helper collapses 15 near-identical provider
  blocks (~250 LOC); iterate the 13 identical `auxiliaryModels` policies
  (~200 LOC); a `section(raw, key)` helper for the ~90 `rawX` destructures.

### Phase 4 — split `normalizeRuntimeConfig`

Break the 1,844-LOC function into per-domain `normalizeXSection(raw, defaults,
deps)` functions living in the domain modules, with the orchestrator remaining in
`runtime-config.ts` to preserve the documented cross-domain ordering:

1. secret-input resolution (before all channel normalizers; results threaded in),
2. channel `enabled` flags computed before their normalizers (gates required-field
   enforcement), same for `imessageBackend`,
3. cross-field clamps (`sessionCompaction.keepRecent` vs threshold), legacy
   migrations feeding current fields (container binds, discord commandMode),
4. `normalizeModelRoutingConfig` **last** — needs all 16 provider model lists +
   local endpoints already normalized.

### End state

`runtime-config.ts` keeps: singleton state (S8), load/apply/watcher/save (S31–S33,
S36), public accessors (S34), skill/tool scope setters (which share the
`WeakMap` autonomy-rule cache with `resolveSkillAutonomyLevel` — keep together),
the normalize orchestrator, the import-time `initializeRuntimeConfig()`, and the
re-export barrel. Target < 1,500 LOC.

---

## 3. `src/gateway/gateway-http-server.ts` (11,276 LOC)

2 exports, 1 consumer. No framework: a single ordered `if`-chain dispatcher with
one auth/RBAC middleware point at line 10379 and three distinct error envelopes
(per-route `.catch`, the `/api` try/catch, the OpenAI `/v1` shape). Crucially,
**no handler closes over server state implicitly** — `terminalManager` and
`activeSseResponses` are parameter-passed everywhere — so route groups move
verbatim. Both house patterns exist: Pattern A "service module" (logic, no
req/res — `gateway-admin-secrets.ts`) and Pattern B "handler module" (takes
req/res — `gateway-http-proxy.ts`, `openai-compatible.ts`).

Non-goals for this refactor: **do not** convert the dispatcher to a route table
(first-match-wins ordering like `/api/admin/skills/upload` before
`startsWith('/api/admin/skills/')` is load-bearing), and do not unify the three
error envelopes. The dispatcher itself staying ~1,200 LOC is acceptable.

### Phase 0 — utils moves (trivial PR)

Move into the existing `gateway-http-utils.ts`: `sendText`, `sendRedirect`,
`sendMethodNotAllowed`, `escapeInlineScriptValue`, `decodeApiPathSegment`,
`dispatchWebhookRoute`, `isJsonObject`, `mergeUniqueStrings` (~50 LOC).

### Phase 1 — auth core (prerequisite)

`gateway-http-auth.ts`: `ResolvedAuthContext`/`ResolvedAuthKind` types,
`resolveAuthContext`, RBAC helpers (`enforceAdminRouteRbac`,
`isApiTokenAllowedForRoute/App`, …), loopback/same-origin helpers, admin-actor
resolvers (lines 2084–2446, ~363 LOC). Ten later modules depend on the exported
type; nothing depends on the http-server file itself, so no cycle risk.

### Phase 2 — low-risk chunks

| New module | Source | LOC | Risk |
|---|---|---|---|
| `gateway-app-shell-scripts.ts` (inline browser JS template literals) | 8053–8188, 8803–9075, 9209–9340 | ~540 | very low |
| `gateway-dev-vite-proxy.ts` (incl. `DEV_VITE_URL` IIFE — import-time warning timing shifts; acceptable) | 9896–10052 | 157 | low |
| `gateway-static-serving.ts` (uses `serveDocs`-style boolean-handled pattern) | 497–518, 2586–2618, 2971–3171 | ~250 | low |
| `gateway-media-paths.ts` (security-sensitive path containment; tests must stay green untouched) | 2685–2970 | 286 | low-med |

### Phase 3 — subsystems (Pattern B handler modules)

| New module | Source | LOC | Notes |
|---|---|---|---|
| `gateway-sse.ts` | 6344 + `handleApiEvents` 7411–7450 | ~60 | `broadcastSseEvent` is shared by browser tool and escalations — extract before both |
| `gateway-browser-tool.ts` | 473–484, 574–1663 | ~1,100 | owns `gatewayBrowserSessions` map; `activeSseResponses` already a param |
| `gateway-interactive-http.ts` | 6257–6568 | 312 | |
| `gateway-admin-agents-http.ts` | 4748–5251 | 504 | own route parser already exists |
| `gateway-admin-jobs-http.ts` | 4128–4339 | 212 | |
| `gateway-admin-a2a-http.ts` | 5451–5728 | 278 | |
| `gateway-admin-skills-http.ts` | 6685–7304 | ~620 | |
| `gateway-apps-http.ts` + `gateway-teams-tab-http.ts` + publications | 7494–9747 minus shells | ~1,700 | export the 6 path parsers to the dispatcher; **preserve the pre-auth/post-auth split** (`/api/apps/:id/view` registers before the middleware, `/api/apps` after) |
| `gateway-chat-http.ts` | 3172–4127 | ~950 | `maybeCaptureChatArtifacts` lives in the apps module; chat imports it (one-directional) — resolves the chat↔apps tangle |

Cross-cutting state: `deploymentPublicUrl` + its `onRuntimeConfigChange`
subscription (used by `resolveRequestOrigin` across apps/Teams/mobile-QR) moves
into the auth-or-origin module behind an accessor.

### End state

`gateway-http-server.ts` keeps: imports, the ordered dispatcher calling imported
handlers, the upgrade handler, lifecycle (`setReady`/`broadcastShutdown`).
The 16,831-LOC test file keeps passing untouched (it mocks dependencies and
drives the composed handler); optionally split it along the same module lines
afterward, mirroring `gateway-admin-secrets.test.ts` precedent.

---

## 4. `src/gateway/gateway-service.ts` (14,308 LOC)

Flat module: ~330 free functions, no classes. Three macro-concerns: the admin
REST surface (~4,000 LOC), the slash-command dispatcher `handleGatewayCommand`
(3,162 LOC) + its private helper layer (~1,300), and delegation/bootstrap
subsystems. Template extractions already exist for every shape needed:
`gateway-distill-service.ts` (admin sub-surface), `skill-commands.ts` /
`policy-command.ts` (per-command modules), `gateway-request-runtime.ts`
(module state behind accessors), `gateway-formatting.ts` (pure formatters).

### Phase 0 — dead code + shared helpers (small PRs)

- ✅ Delete dead exports: `cloneMediaContextItems`, `enqueueDelegationFromSideEffect`,
  `extractUsageCostUsd`.
- ✅ `gateway-command-results.ts`: `badCommand`/`infoCommand`/`plainCommand`
  (283 call sites) — and delete the duplicates in `gateway-plugin-service.ts`
  and `src/goals/goal-command.ts`. This unblocks all per-command extraction.
- ✅ Move `formatPercent`/`formatUsd`/`formatUptime`/
  `formatPerformanceTokensPerSecond` (+ private `formatThroughput`/
  `formatTokensPerSecond`) into the existing `gateway-formatting.ts`.
- Shared consts module for `BOT_CACHE_TTL`; exported predicate
  `hasActiveBootstrapAutostartForSession()` for the one cross-concern peek at
  `activeBootstrapAutostartSessions` (line 9623).

### Phase 1 — pure helper modules (~2,000 LOC, zero-risk)

`gateway-request-log-redaction.ts` (911–1161, 251) ·
`gateway-media-context.ts` (2289–2450, 162) ·
`gateway-session-prune.ts` (3957–4179, 223) ·
`gateway-auth-status.ts` (3323–3645, 323) ·
`gateway-build-diagnostics.ts` (4596–4712 + git-short cache, ~137) ·
`gateway-memory-reports.ts` (2958–3229, 272) ·
`gateway-trace-export.ts` (2471–2657, 3230–3269, ~227) ·
`gateway-hybridai-bots.ts` (2652–2867 incl. `resolveGatewayChatbotId`, 216) ·
`gateway-mcp-config.ts` (4381–4496, 116) ·
`gateway-secret-routes.ts` (4180–4299, 120) ·
`gateway-model-format.ts` (2193–2264, 4300–4363, ~136).

### Phase 2 — subsystem moves (highest LOC-per-effort)

| New module | Source | LOC |
|---|---|---|
| `gateway-admin-skills.ts` | 7540–8560 (+const blocks) | ~1,050 |
| `gateway-delegation.ts` | 1162–1318, 9755–11050 | ~1,450 |
| `gateway-bootstrap-autostart.ts` | 748–901, 8561–9333 | ~930 |
| `gateway-admin-agent-markdown.ts` | 1456–2163, 5169–5508 | ~1,050 |
| `gateway-admin-channels.ts` (channels/config/webhook targets) | 5890–6296 | ~410 |
| `gateway-admin-a2a.ts` | 6297–6674 | ~380 |
| `gateway-admin-models.ts` + `gateway-admin-mcp.ts` | 6853–7220 | ~370 |
| `gateway-admin-policy-audit.ts` | 7221–7539 | ~320 |
| `gateway-status-service.ts` (`getGatewayStatus` + overview) | 4713–4991 | ~280 |

Repoint `gateway-http-server.ts` imports directly at the new modules (house
style); keep re-exports in `gateway-service.ts` for the 43 test files until they
are repointed in follow-up PRs (the largest test files map 1:1 onto the new
modules: `gateway-status.test.ts`, `gateway-service.admin-skills.test.ts`,
`gateway-service.bootstrap-autostart.test.ts`, `gateway-service.audit.test.ts`).

### Phase 3 — split `handleGatewayCommand`

Extract per-command modules using the params-object pattern
(`handleXCommand(ctx: GatewayCommandContext)` with
`ctx = { req, session, pluginManager, pluginInitError, isLocalSession }`),
starting with the six largest cases: `agent` (411), `secret` (298), `model`
(228), `status` (182), `mcp` (179), `sessions` (163) — 1,461 LOC. Precedent:
`goal`, `policy`, `btw`, `skill`, `eval` cases already delegate to external
modules. `attachCommandSessionIdentity` stays in the dispatcher. Remaining
small cases can stay inline; the dispatcher lands around 1,200 LOC.

### Phase 4 — break the ESM cycle

`gateway-service.ts → gateway-plugin-service.ts → gateway-chat-service.ts →
gateway-service.ts` is an existing cycle. Move the 24 chat-pipeline exports
consumed by `gateway-chat-service.ts` (turn recording, media context, request
logging, session policies — most already extracted in Phase 1) into leaf modules
so `gateway-chat-service.ts` no longer imports `gateway-service.ts` at all.

---

## Suggested sequencing

Weeks are illustrative; phases within a file are ordered, files are parallel.

1. **PR wave 1 (Phase 0 × 4):** dead code, de-exports, shared helper dedup.
   Small, reviewable, immediately reduces later diff noise.
2. **PR wave 2 (structural wins):** db schema extraction (−3,080) ·
   runtime-config primitives + types + defaults (−2,000) · http auth core +
   shell scripts (−900) · gateway-service pure helpers (−2,000).
3. **PR wave 3 (subsystems):** db Tier-1 stores · runtime-config zero-coupling
   domains · http browser-tool/escalations/admin groups · gateway-service
   admin + delegation + bootstrap moves.
4. **PR wave 4 (the hard cores):** db domain stores · channel normalizers +
   `normalizeRuntimeConfig` split · apps/publications/Teams http split ·
   `handleGatewayCommand` split + cycle break.
5. **Follow-up:** repoint high-traffic consumers off the barrels; split the
   monolithic test files along module lines; consider un-baring `db.ts`
   dynamic-import sites opportunistically.

## Risk register

| Risk | Mitigation |
|---|---|
| 77 dynamic `await import('memory/db.js')` sites bypass static analysis | permanent barrel; grep for dynamic imports before any de-export |
| `vi.mock`/`vi.doMock` keyed by module path | never shim mocked paths; new modules import the same dep paths |
| `initializeRuntimeConfig()` import side effect | stays in the barrel; extracted modules stay pure; the 52 dynamic-import tests keep working |
| Secret round-trip (`resolveConfiguredSecretInput` at load vs `preserve*SecretInputs` at save) | move resolve/preserve pairs together, covered by `runtime-config.secret-refs.test.ts` |
| Dispatcher first-match-wins ordering | no route-table conversion; moves keep guard order byte-identical; 380-test suite as characterization |
| `normalizeRuntimeConfig` cross-domain ordering (enabled flags, secret threading, routing catalog last) | orchestrator retains explicit ordered steps; domain fns take deps as params |
| ESM cycle gateway-service ↔ chat-service ↔ plugin-service | Phase 4 leaf-module break; until then keep import directions unchanged |
| Untested db domains (KG, KV, stats, proactive queue, scoring) | characterization tests before moving |
