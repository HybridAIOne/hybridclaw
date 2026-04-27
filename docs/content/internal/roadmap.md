---
title: Trusted Coworker Roadmap
description: Internal product roadmap derived from the Trusted Coworker Manifesto. Not linked from the public docs nav.
---

> **Internal document.** This page is intentionally excluded from the docs sidebar, navigation, and search — but it remains web-accessible by direct URL, which is how GitHub issue bodies reference it. Source of truth for roadmap planning. Tracked in the umbrella issue [HybridAIOne/hybridclaw#466](https://github.com/HybridAIOne/hybridclaw/issues/466).

# Trusted Coworker Roadmap

21 features grouped into three priority tiers. **P0** = Very High Priority (launch package). **P1** = High Priority (depth). **P2** = Priority (breadth). Sequencing within a tier is driven by technical dependencies.

The roadmap is anchored in the [Trusted Coworker Manifesto](../manifesto.md). Numbers in *italic* below each feature link the work back to the principle it serves.

| # | Feature | Description | Priority |
|---|---------|-------------|----------|
| 21 | **Business-skill pipeline + first 5 production skills** | Opinionated, ready-on-day-one skills (Salesforce, HubSpot, SAP, GA4, NL→SQL on warehouse) on top of a shared packaging + lifecycle framework. *Principle I — the skills are the product.* | P0 |
| 1 | **Agent-to-agent messaging** | First-class primitive for one coworker to message, hand off, or escalate to another. Persisted envelopes; intent typed; integrates with the hash-chain audit log. *Principle VI.* | P0 |
| 2 | **Workflow engine — autonomous-by-default with high-stakes escalation** | Declarative YAML workflows. Sequential runner; escalation gates only on high-stakes steps (driven by F8 stakes classifier — **not** approval-by-default). Return-for-revision rewinds. Built on top of #1. *Principles II + VI.* | P0 |
| 3 | **Coworker scoreboard + auto-`CV.md`** | Per-skill score data model populated from the skill-run event bus. Auto-rendered CV per coworker; admin scoreboard; "best at X" recommendation API. *Principle IV.* | P0 |
| 4 | **Business-secret masking + demasking** | Extends `confidential-redact.ts` with NDA / client / price / contract classes. Round-trip placeholder scheme; post-LLM rehydrator; mask/demask events on the audit log. *Principle VII.* | P0 |
| 5 | **Token / money budgets per coworker** | Per-coworker monthly € cap backed by existing `UsageTotals`. Soft-warn at threshold, hard-stop via the policy engine, per-skill sub-limits. *Principle IX.* | P0 |
| 6 | **NDA / secret-leak classifier** | Classifier on every prompt and response, fed by the skill-run event bus. Block / warn / log via policy engine; eval suite extends the existing harness. *Principle VII.* | P0 |
| 7 | **Shared enterprise memory** | RAG over team docs / CRM / wiki, available in self-hosted HC. Pluggable vector store, per-coworker source scoping, retrieval-quality eval suite. *Principle I.* | P1 |
| 8 | **Brand-voice + output classifier** | Per-tenant voice profile (do / don't, tone, banned phrases). Pre-ship classifier on responses; block / rewrite via policy engine. *Principle VII.* | P1 |
| 9 | **Hierarchical swarm — HC1 delegates to HC2** | Cross-instance delegation. Signed delegation tokens, transport over HTTP, audit-log linking across instances. *Principle VI.* | P1 |
| 10 | **Auto fine-tuning on real tasks** | Trajectory capture → PII scrub → per-customer training data → fine-tuning pipeline → tuned-model registry with eval gate before promotion. *Principle VIII.* | P1 |
| 11 | **Operator notification windows + escalation routing** | *Reframed under v3 Principle III.* The coworker is always on; this issue covers per-operator notification preferences (when to page vs. queue for the morning summary) and escalation routing through F8. | P2 |
| 12 | **Mobile-first admin (iOS / Android wrapper)** | Responsive admin pages, mobile-friendly approval flow, push notifications, native wrappers via Capacitor or React Native. *Principle X.* | P1 |
| 13 | **Per-client cost & audit reports** | Client tagging on activity, per-client cost rollup extending #5, per-client audit-log filter, branded PDF export. *Principle VII.* | P1 |
| 14 | **SSO + RBAC** | OAuth2 / OIDC framework with Okta, Google Workspace, Microsoft Entra providers. Role + permission model; per-coworker access policies for human users. *Principle VII.* | P1 |
| 15 | **Coworker handoff with context transfer** | Extends the `handoff` intent from #1 to carry a context bundle (thread refs, brief, client tags). Recipient absorbs context before resuming. *Principle VI.* | P2 |
| 16 | **Skill A/B testing + canary deployments** | Variant routing by deterministic hash, per-variant metrics from the event bus, statistical comparison, promotion gate via the eval harness. *Principle VIII.* | P2 |
| 17 | **Coworker references / portfolio export** | Anonymized portfolio bundle (work samples + scores). Export and import flows so a coworker template can be instantiated on a fresh instance. *Principle IV.* | P2 |
| 18 | **Voice / outbound phone channel** | Twilio Programmable Voice for outbound dial. Existing TTS plus STT for callee responses; call-flow primitive; transcript on the audit log. *Principle V.* | P2 |
| 19 | **Calendar / meeting presence** | Bot joins Zoom / Meet, real-time STT, live notes, post-meeting summary, action-item dispatch via #1 to other coworkers. *Principle V.* | P2 |
| 20 | **Right-to-be-forgotten / GDPR data export** | Identifier registry, cascading data discovery, audited deletion, machine + human readable export. Hash-chain entry of the deletion preserved. *Principle VII.* | P2 |

---

## Foundations

Cross-cutting work that several roadmap items depend on. Decomposed under the `foundation` label rather than belonging to any single feature.

- **F1** — Extend `AgentConfig` with `owner` / `role` / `cv` fields and persistence. `owner` is a typed reference to a canonical user (see F7). Required by #1, #3, #5, #11, #21.
- **F2** — Unified skill-run event bus (streaming, not post-hoc). Required by #3, #5, #6, #10, #16, F8.
- **F3** — Generalize the network-only policy engine into a "predicate → action" engine. Used by #4, #5, #6, #8, #14, F8.
- **F4** — Versioning + rollback for skills, knowledge, CVs, and classifier weights. Extends `runtime-config-revisions`. Required by Principle VII.
- **F5** — Model pricing & capability matrix on top of `model-catalog`. Required by #5 cost compute and future routing.
- **F6** — Deployment-mode + public-URL abstraction. Cloud installs declare an external URL; local installs run a tunnel (ngrok / Cloudflare / Tailscale). Required by #9, #18, #19, and the launch smoke scenario A1 in local mode.
- **F7** — Global identity primitives. Canonical user IDs (`username@authority`, default authority `hybridai`) and canonical agent IDs (`agent-slug@user@instance-id`), plus a resolver and TOFU trust model. Required by #1 envelope addressing, #9 cross-instance delegation, #14 SSO federation, #15 handoff, #17 portfolio refs.
- **F8** — Autonomy + escalation policy framework. Per-coworker / per-skill autonomy levels, stakes classifier, escalation routing, default-action runtime that inverts approval-by-default. **Required by Principle II** and reframes the default behaviour of #2.
- **F9** — Always-on runtime guarantees. Warm process pool, per-coworker liveness probe, auto-restart with backoff, fleet red/green dashboard. **Required by Principle III** ("doesn't clock out") — without it the principle is aspirational.
- **F10** — Coworker org-chart / team primitive. Roles, reporting lines, escalation chains as first-class data — not derived from message graphs. Required by F8 escalation routing and #15 handoff context.

## Cross-cutting additions

Engineering hygiene that ships alongside P0:

- **A1** — End-to-end smoke scenario exercising #1 + #2 + #3 + #4 + #5 + #6 in one run.
- **A2** — `CHANGELOG.md` with manifesto-principle tags per entry.
- **A3** — Test-fixtures library (coworkers, clients, threads, secrets).
- **A4** — CI cost-regression gate against the eval suite.
- **A5** — Threat-model document for any feature touching secrets or keys.

---

## How to read this

**P0 (#21 + #1–6)** is the launch package. Read it as the smallest set of features that makes the manifesto demonstrable end-to-end:

- **#21** implements Principle I — *the skills are the product*. Without shippable skills, everything else is a runtime, not a coworker.
- F8 + #2 implement Principle II — autonomy by default, escalate on stakes.
- F9 implements Principle III — always on, no warm-up.
- #3 + F10 implement Principle IV — colleague with a CV; org chart not flat list.
- #1 + #2 + F10 implement Principle VI — coworkers in teams.
- #4 + #6 + F4 implement Principle VII — trust + audit + reversibility.
- #5 implements Principle IX — thinks before spending.
- F1 + F2 + F3 are prerequisites for the above.

**P1 (#7–10, #12–14)** is depth work. Each item compounds with one or more P0 features:

- Shared memory (#7) and auto fine-tuning (#10) close the data flywheel — both feed back into the skill scoreboard (#3) and the leak classifier (#6).
- Hierarchical swarm (#9) extends the A2A primitive (#1) across host instances; depends on F6 + F7.
- Per-client reports (#13) and SSO/RBAC (#14) are operational table stakes once a fleet is in use.
- Mobile admin (#12) is the surface for Principle X on a phone.

**P2 (#11, #15–20)** is breadth. Each item is independently shippable but most depend on at least one P1 item:

- Operator notification windows (#11) was reframed away from "agent goes offline" semantics; demoted from P1 → P2.
- Handoff context transfer (#15) makes #1 + #2 feel finished.
- A/B testing (#16) compounds with #10.
- Voice (#18) and calendar (#19) are channel expansions on top of the existing channel layer.
- RTBF (#20) is the GDPR baseline; mostly implementation work on top of the audit log.

## Sequencing rules

- **Foundations first.** F1, F2, F3 unblock the majority of P0 children. F4 and F5 unblock specific items. F6 and F7 are critical-path the moment any cross-instance work or local-install demo is involved. F8, F9, F10 are needed as soon as the launch demo (A1) tries to honour Principles II / III / VI.
- **Skills early.** #21.1 (skill packaging framework) should land before any of #21.2-#21.6 (the five production skills). Without the framework each skill reinvents lifecycle + permissioning.
- **A2A before workflow.** #1 must ship at least to 1.2 (send/receive runtime API) before #2.2 (sequential runner) becomes useful.
- **F8 alongside #2.** #2.3 (gating semantics) should not land before F8.4 (default-action runtime) — otherwise #2 hard-codes approval-by-default and has to be refactored.
- **Trajectory capture starts early.** 10.1 (trajectory collection) should land alongside F2, well before the rest of #10 — the data is the asset.
- **Leak classifier needs a dataset.** 6.1 (classifier dataset) gates 6.2 / 6.3; budget for labeling time.
- **Avoid net-new channels until P0 ships.** New channel work (#18, #19) is deferred to P2 even where infrastructure exists.

## Out of scope

- Net-new chat channels beyond what already ships in `src/channels/`.
- Generic "more skills" beyond the production-grade five in #21 — additional skills are folded into the same pipeline, not added as feature-count items.
- Anything that requires the end user to open the desktop app (Principle V).
- Per-coworker "away" / clock-out semantics — explicitly anti-Principle III.
