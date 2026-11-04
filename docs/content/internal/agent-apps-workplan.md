---
title: Agent Apps — Work Plan
description: Parked work plan for letting an owner-approved HybridClaw app run skill turns with file upload and artifact download (Hilfeplan case). Drafted 2026-11-04; nothing started.
---

> **Internal document.** Parked work plan, not scheduled. Drafted 2026-11-04 from a code read of the apps bridge, publications and the HybridAI hosted-apps feature. Intended to become a GitHub issue when the work is picked up.

# Agent Apps — Work Plan

## Why

A customer case (youth-welfare Hilfeplan reports, `skills/hilfeplan`) needs a guided front end for case workers: upload the group documentation and the Hilfeplan template, pick child and period, get the generated `.docx` back. Today the only UI that does this end to end is the HybridClaw console chat.

We looked at the two app mechanisms we have and neither can drive a skill:

- **HybridAI hosted apps** (`chat` repo, #3247 ff.) are locked to `/v1/chat/completions`, `/v1/models`, `/v1/knowledge/*`. By design (#3258) an app token is refused `platform_tools`, connectors, `hybridclaw:*` agent models and the bot's tools; it cannot upload binary files. Building the case there means re-implementing the skill in browser JS.
- **HybridClaw apps** already have most of the plumbing — per-viewer sessions, publications (link / password / Entra OIDC), scoped `hck_` tokens with `appIds`, a `postMessage` bridge that runs a real agent turn — but the bridge is intentionally limited to one read-only MCP tool per call (`LIVE_APP_BRIDGE_READ_ONLY_TOOL_PREFIXES`, `maxTokens: 512`, 120 s wall clock).

This issue records the work to extend HybridClaw apps so an owner can opt one app into running skill turns with files. Parked for now; nothing here is started.

## Design decisions to settle first

1. **Owner opt-in, not HTML.** An app runs agent turns only when its owner sets `bridge: { mode: 'agent', skills?: [...], allowedTools?: [...] }` on the app record. Generated HTML can never widen its own rights (same boundary as today's read-only list; document it in `docs/content/guides/apps.md`).
2. **Data separation between viewers.** Sessions are per viewer (`agent:…:app:pub:<appId>:<viewerSub>`) but the workspace is per agent, so case files of all viewers share `hilfeplan/faelle/`. Either enforce a per-viewer subfolder (instruction + artifact scoping below) or give such customers a dedicated agent. Decide before shipping to a customer with personal data.
3. **Async runs.** A Hilfeplan turn over ~100k chars takes minutes; the bridge limits (120 s / 60 s inactivity) do not fit. Use start + poll (same shape as `plugins/published-tools` `hybridclaw_get_result`); in-memory run store is acceptable for v1.

## Work packages

**WP1 — `POST /api/apps/:id/bridge/chat`** (`src/gateway/gateway-http-server.ts`, next to `handleApiAppBridgeTool` / `runLiveAppBridgeTool`)
Body `{ content, media[], instructions? }`; runs a full turn in the viewer's session with the app's configured skill/tool allowlist; returns `{ runId }`. Extract the session/agent/chatbot resolution from `runLiveAppBridgeTool` into a shared helper. Approvals surface as `pendingApproval` (viewer already shows a 409 banner).

**WP2 — `GET /api/apps/:id/bridge/run/:runId`**
Status (`running | completed | approval_required | failed`), last tool-progress line (from `emitGatewayToolProgress`), and on completion `{ text, artifacts: [{ path, filename, mimeType }] }`.

**WP3 — Upload and artifact access for scoped tokens** (security-relevant, own commit)
`/api/media/upload` and `/api/artifact` have no RBAC mapping (`src/security/admin-rbac.ts` ~L420–440), so scoped tokens would need `*`. Add actions `media.upload` and `artifacts.read`; `handlePublicationSessionExchange` includes them only for `agent`-mode apps. Restrict `handleApiArtifact` for app tokens to paths inside the app agent's workspace **and** listed in `artifacts[]` of a run of that viewer's session — the resolver currently accepts any path under `DATA_DIR/agents`.

**WP4 — Bridge client + shells**
Extend `buildLiveAppBridgeScript` with `window.hybridclaw.uploadFile(file)` (ArrayBuffer via `postMessage`), `chat({ content, media, onProgress })` (start + poll) and `artifactUrl(path)`. Relay the new message types in `/pub-shell.js` and the console apps viewer; all same-origin, no CORS.

**WP5 — The Hilfeplan app**
A `live` app (via `/app` or hand-written): uploads for Tagesdoku / Hilfeplan / Vorlage, child + period + report type, progress, download link, "draft — the responsible professional must review and sign". Prompt mirrors the test instructions in the demo dataset (`~/Downloads/Hilfeplan-Demodaten-v2/Testanleitung_Skill_hilfeplan.md`).

**WP6 — Publication, tests, docs**
Publication with `oidc` (customer's Entra) or `password`, `allowBridge: true`. Tests in `tests/gateway-http-server.test.ts`: bridge chat happy path, refusal without owner opt-in, artifact scoping across viewers, upload quota. "Agent apps" section in `docs/content/guides/apps.md`.

Rough effort: ~3 days, one of them WP3.

## Out of scope

- Making HybridAI hosted apps reach HybridClaw (would reverse #3258; separate discussion).
- Streaming the turn into the app (polling is enough for v1).
- Published Tools (MCP) as transport: text in / text out, artifacts dropped — not a fit for file-producing skills.

## References

- `docs/content/guides/apps.md` (live-app bridge, security boundaries)
- `src/security/app-publications.ts`, `handlePublicationSessionExchange`
- `plugins/published-tools/src/tool-server.js` (async run pattern)
- `skills/hilfeplan/SKILL.md` §"Deliver" (artifact handoff by naming the `.docx` path)
