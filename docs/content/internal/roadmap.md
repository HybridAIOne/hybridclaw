---
title: Agent, That Really Works — Roadmap
description: Internal product roadmap derived from the Trusted Coworker Manifesto. Not linked from the public docs nav.
---

> **Internal document.** This page is intentionally excluded from the docs sidebar, navigation, and search — but it remains web-accessible by direct URL, which is how GitHub issue bodies reference it. Source of truth for roadmap planning. Tracked in the umbrella issue [HybridAIOne/hybridclaw#466](https://github.com/HybridAIOne/hybridclaw/issues/466).

# Agent, That Really Works — Roadmap

21 features grouped into three priority tiers. **P0** = Very High Priority (launch package). **P1** = High Priority (depth). **P2** = Priority (breadth). Sequencing within a tier is driven by technical dependencies.

The roadmap is anchored in the [Trusted Coworker Manifesto](../manifesto.md). Numbers in *italic* below each feature link the work back to the principle it serves.

> **Naming convention.** Product, manifesto, and marketing surfaces use **Coworker** (*"hire Lena"*). Code, admin UI, CV, scoreboard, types, and APIs use **Agent**. The two refer to the same entity. This roadmap uses *Agent* in technical descriptions and reverts to *Coworker* when paraphrasing the manifesto. See `docs/content/manifesto.md` for the customer-facing voice.

## Status snapshot — 2026-04-29

**Foundations:** 5 of 11 fully done (F1–F5 ✅) · **F6 now 4/5 + F6.6 ✅** (F6.1 ✅, F6.2 ✅, F6.3 ✅, F6.4 ✅, **F6.6 Tailscale Funnel ✅ #644**) · **F8 now 3/5** (F8.1 ✅, F8.2 ✅, F8.3 ✅) · **F9 now 1/4** (**F9.1 warm process pool ✅ #590**) · **F10 now 2/4** (F10.1 ✅, **F10.2 persisted team structures ✅ #595**) · **F11 now 2/4** (F11.1 ✅, **F11.2 trace preparation ✅ #621**) · F7 not started.

**P0 features:** R3 fully done · **R21 now 2/10** (R21.1 framework ✅ + R21.2 Salesforce ✅; **R21.6 NL→SQL 🔄 #584**) · R1 1/5 (R1.1 ✅; **R1.2 send/receive runtime API 🔄 #425**) · R5 1/6 (R5.1 ✅) · **R2 🔄 #461 (umbrella in flight)** · R4, R6 not started.

**Cross-cutting:** A2 + A3 done (2 of 5) · A1, A4, A5 not started.

**P1/P2:** **R10 now 3/7** (R10.1 ✅ + R10.2 ✅ + R10.3 ✅) · **R8 now 3/5** (**R8.1 schema ✅ #474, R8.2 pre-ship classifier ✅ #475, R8.3 block/rewrite ✅ #476** — all via PR #408) · **R23 backup CLI ✅ #635** (via PR #428) · **R27 async usage buffer ✅ #663** (via PR #467) · **R3.7 chronological CV.md ✅ #618** (R3 follow-up). R9 peer-delegation (PR #409) + R28 provider fallback chain (PR #413) still in flight.

**EU positioning bundle filed:**
- *Connectivity:* **F6.6 Tailscale ✅ #644** · F6.7 Cloudflare · R18.7 SIP outbound · R24 SMS channel · **R26 Fax gateway** (new — DACH B2B / Steuerberater workflows)
- *Deployment:* R25 EU deployment recipes (Hetzner / IONOS / Open Telekom Cloud)
- *Skills:* R21.7 Hetzner DevOps · R21.8 SAP Analytics Cloud · R21.9 DATEV · R21.10 Lexware Office

**Total closed roadmap issues:** **42 of ~152 (≈28%)** — up from 33 at last update (9 new closures: R3.7 #618, R8.1–8.3 #474/#475/#476, R23 #635, R27 #663, F6.6 #644, F9.1 #590, F10.2 #595, F11.2 #621). **Foundation/feature mix shifting:** F11.2 trace prep is now done (was gating R6 leak / R8 brand voice / R10 trajectory rating); next critical-path picks are **F9.2–F9.4 always-on runtime children** (now in flight under #600 — Principle III), **F10.3–F10.4 team-structure children**, and **F11.3 + F11.4** (eval-the-judge + subscriber pattern).

**Currently in flight (2026-04-29):** R21.6 NL→SQL [#584](https://github.com/HybridAIOne/hybridclaw/issues/584) · R2 workflow engine [#461](https://github.com/HybridAIOne/hybridclaw/issues/461) · R1.2 A2A send/receive runtime API [#425](https://github.com/HybridAIOne/hybridclaw/issues/425) (sequencing prereq for R2.2) · F9 always-on runtime [#600](https://github.com/HybridAIOne/hybridclaw/issues/600) (Principle III).

## Status legend

✅ Done · 🟡 *N/M* partial (children closed/total) · 🔄 PR in flight · ⬜ Not started

| # | Feature | Description | Priority | Status |
|---|---------|-------------|----------|--------|
| 21 | **Business-skill pipeline + production skills** | R21.1 framework + 5 launch skills (Salesforce, HubSpot, SAP ERP, GA4, NL→SQL warehouse) + R21.7 Hetzner DevOps suite + R21.8 SAP Analytics Cloud + R21.9 DATEV + R21.10 Lexware Office. *Principle I — the skills are the product.* | P0 | 🟡 2/10 (R21.1 ✅, R21.2 ✅; R21.6 🔄 #584) |
| 1 | **Agent-to-agent messaging** | First-class primitive for one agent to message, hand off, or escalate to another. Persisted envelopes; intent typed; integrates with the hash-chain audit log. *Principle VI.* | P0 | 🟡 1/5 (R1.2 🔄 #425) |
| 2 | **Workflow engine — autonomous-by-default with high-stakes escalation** | Declarative YAML workflows. Sequential runner; escalation gates only on high-stakes steps (driven by F8 stakes classifier — **not** approval-by-default). Return-for-revision rewinds. Built on top of #1. *Principles II + VI.* | P0 | 🔄 #461 (umbrella in flight) |
| 3 | **Agent scoreboard + auto-`CV.md`** | Per-skill score data model populated from the skill-run event bus. Auto-rendered CV per agent; admin scoreboard; "best at X" recommendation API. *Principle IV.* | P0 | ✅ (5/5; follow-up R3.7 ✅ #618; #616, #619 still open) |
| 4 | **Business-secret masking + demasking** | Extends `confidential-redact.ts` with NDA / client / price / contract classes. Round-trip placeholder scheme; post-LLM rehydrator; mask/demask events on the audit log. *Principle VII.* | P0 | ⬜ |
| 5 | **Token / money budgets per agent** | Per-agent monthly € cap backed by existing `UsageTotals`. Soft-warn at threshold, hard-stop via the policy engine, per-skill sub-limits. *Principle IX.* | P0 | 🟡 1/6 |
| 6 | **NDA / secret-leak classifier** | Classifier on every prompt and response, fed by the skill-run event bus. Block / warn / log via policy engine; eval suite extends the existing harness. *Principle VII.* | P0 | ⬜ (#406 shipped a rule-based variant) |
| 7 | **Shared enterprise memory** | RAG over team docs / CRM / wiki, available in self-hosted HC. Pluggable vector store, per-agent source scoping, retrieval-quality eval suite. *Principle I.* | P1 | ⬜ |
| 8 | **Brand-voice + output classifier** | Per-tenant voice profile (do / don't, tone, banned phrases). Pre-ship classifier on responses; block / rewrite via policy engine. *Principle VII.* | P1 | 🟡 3/6 (R8.1 ✅, R8.2 ✅, R8.3 ✅ via PR #408; R8.4 #477 profile editor, R8.5 #478 per-channel variants, **R8.6 #682 gate enforcement config** open) |
| 9 | **Hierarchical swarm — HC1 delegates to HC2** | Cross-instance delegation. Signed delegation tokens, transport over HTTP, audit-log linking across instances. *Principle VI.* | P1 | 🔄 PR #409 |
| 10 | **Auto fine-tuning on real tasks** | Trajectory capture → PII scrub → per-customer training data → fine-tuning pipeline → tuned-model registry with eval gate before promotion. *Principle VIII.* | P1 | 🟡 3/7 (R10.1 ✅, R10.2 ✅, R10.3 ✅) |
| 11 | **Operator notification windows + escalation routing** | *Reframed under v3 Principle III.* The coworker is always on; this issue covers per-operator notification preferences (when to page vs. queue for the morning summary) and escalation routing through F8. | P2 | ⬜ (2 anti-principle children closed) |
| 12 | **Mobile-first admin (iOS / Android wrapper)** | Responsive admin pages, mobile-friendly approval flow, push notifications, native wrappers via Capacitor or React Native. *Principle X.* | P1 | ⬜ |
| 13 | **Per-client cost & audit reports** | Client tagging on activity, per-client cost rollup extending #5, per-client audit-log filter, branded PDF export. *Principle VII.* | P1 | ⬜ |
| 14 | **SSO + RBAC** | OAuth2 / OIDC framework with Okta, Google Workspace, Microsoft Entra providers. Role + permission model; per-agent access policies for human users. *Principle VII.* | P1 | ⬜ |
| 15 | **Agent handoff with context transfer** | Extends the `handoff` intent from #1 to carry a context bundle (thread refs, brief, client tags). Recipient absorbs context before resuming. *Principle VI.* | P2 | ⬜ |
| 16 | **Skill A/B testing + canary deployments** | Variant routing by deterministic hash, per-variant metrics from the event bus, statistical comparison, promotion gate via the eval harness. *Principle VIII.* | P2 | ⬜ |
| 17 | **Agent references / portfolio export** | Anonymized portfolio bundle (work samples + scores). Export and import flows so an agent template can be instantiated on a fresh instance. *Principle IV.* | P2 | ⬜ |
| 18 | **Voice / outbound phone channel** | Twilio Programmable Voice for outbound dial. Existing TTS plus STT for callee responses; call-flow primitive; transcript on the audit log. R18.7 adds SIP outbound for B2B operators with existing PBX/SIP trunks. *Principle V.* | P2 | ⬜ |
| 19 | **Calendar / meeting presence** | Bot joins Zoom / Meet, real-time STT, live notes, post-meeting summary, action-item dispatch via #1 to other agents. *Principle V.* | P2 | ⬜ |
| 20 | **Right-to-be-forgotten / GDPR data export** | Identifier registry, cascading data discovery, audited deletion, machine + human readable export. Hash-chain entry of the deletion preserved. *Principle VII.* | P2 | ⬜ |
| 22 | **Async voice channel** | Inbound voice notes (STT) + outbound TTS replies, channel-agnostic. Wires through existing voice-tts integration. *Principle V.* | P2 | ⬜ |
| 23 | **Whole-instance backup + restore (disaster recovery)** | `hybridclaw backup` + `restore` CLI for WAL-safe SQLite snapshot + zip-archive re-hydration on a fresh host. *Principle VII.* | P1 | ✅ #635 (via PR #428) |
| 24 | **SMS channel via European operator APIs** | Pluggable SMS provider via the existing channel layer — Telekom MMS API, Vodafone Messaging, 1&1 SMS gateway. For transactional B2B messaging (OTPs, alerts) where WhatsApp/Telegram aren't the right modality. *Principle V.* | P2 | ⬜ |
| 25 | **EU deployment recipes (Hetzner / IONOS / Open Telekom Cloud)** | Operator guides for deploying HybridClaw on each EU cloud provider — Docker Compose, Terraform, secret-store setup, F6-tunnel vs cloud-native ingress, backup wiring (R23). DSGVO talking points for sales. *Principle X.* | P1 (Hetzner) / P2 (IONOS, OTC) | ⬜ |
| 26 | **Fax gateway + outbound skill** | Inbound fax-to-email → existing email channel; outbound fax-send skill with pluggable EU-resident provider (Telekom Cloud Fax / Sinch / Vodafone Fax2Mail / T.38 over R18.7 SIP). *Principle V — DACH B2B Steuerberater + healthcare + legal workflows.* | P2 | ⬜ |
| 27 | **Async tamper-evident token-usage buffer** | Producer-consumer queue decouples model invocations from synchronous chargeback DB writes; periodic batch flush emits SHA-256-hashed `usage.batch_flushed` audit events. Substrate for R5.x at scale. *Principle VII.* | P1 | ✅ #663 (via PR #467) |
| 28 | **Provider fallback chain (resilience)** | Auth (401/403) → immediate switch; rate-limit (429) → switch + cooldown on primary-leave only; streaming-safe; configured via `HYBRIDAI_FALLBACK_CHAIN`. *Principle VIII — doesn't break overnight when a provider has an outage.* | P1 | 🔄 PR #413 |

---

## Foundations

Cross-cutting work that several roadmap items depend on. Decomposed under the `foundation` label rather than belonging to any single feature.

- ✅ **F1** — Extend `AgentConfig` with `owner` / `role` / `cv` fields and persistence. `owner` is a typed reference to a canonical user (see F7). Required by #1, #3, #5, #11, #21.
- ✅ **F2** — Unified skill-run event bus (streaming, not post-hoc). Required by #3, #5, #6, #10, #16, F8.
- ✅ **F3** — Generalize the network-only policy engine into a "predicate → action" engine. Used by #4, #5, #6, #8, #14, F8.
- ✅ **F4** — Versioning + rollback for skills, knowledge, CVs, and classifier weights. Extends `runtime-config-revisions`. Required by Principle VII.
- ✅ **F5** — Model pricing & capability matrix on top of `model-catalog`. Required by #5 cost compute and future routing.
- 🟡 **F6 (4/5 + F6.6 ✅)** — Deployment-mode + public-URL abstraction. F6.1 (config schema) ✅, F6.2 (TunnelProvider + ngrok ref impl) ✅, F6.3 (health check + auto-reconnect with capped-backoff jitter) ✅, F6.4 (admin surface for public URL + tunnel status — read-only + reconnect) ✅. F6.5 docs still open. **Additional providers:** **F6.6 Tailscale Funnel ✅ #644**, F6.7 Cloudflare Tunnel #645 still open — both P1, both slot into the F6.2 interface. **F6.8 admin UI for tunnel provider configuration** [#681](https://github.com/HybridAIOne/hybridclaw/issues/681) (P1) — extends F6.4 with edit/save (mode switch, provider picker, credential storage) so operators don't need to edit config files; pairs with F6.7.
- ⬜ **F7** — Global identity primitives. Canonical user IDs (`username@authority`, default authority `hybridai`) and canonical agent IDs (`agent-slug@user@instance-id`), plus a resolver and TOFU trust model. Required by #1 envelope addressing, #9 cross-instance delegation, #14 SSO federation, #15 handoff, #17 portfolio refs. *(Note: R1.1 inline-implements the bare-minimum canonical-id; full F7 still needed for #9.)*
- 🟡 **F8 (3/5)** — Autonomy + escalation policy framework. F8.1 (autonomy levels) ✅, F8.2 (stakes classifier) ✅, **F8.3 (escalation routing) ✅**. F8.4 default-action runtime + F8.5 audit events still open (note: F8.4 substantially shipped via #608 + #641 — scope-check before re-implementing). **Required by Principle II.**
- 🟡 **F9 (1/4)** — Always-on runtime guarantees. **F9.1 (warm process pool / cold-start budget) ✅ #590**. Umbrella [#600](https://github.com/HybridAIOne/hybridclaw/issues/600) 🔄 in flight; F9.2 liveness probe #591 / F9.3 auto-restart with backoff #592 / F9.4 fleet red/green dashboard #593 still open. **Required by Principle III** ("doesn't clock out").
- 🟡 **F10 (2/4)** — Agent org-chart / team primitive. F10.1 (schema: roles, reports_to, delegates_to, peers + tree validation) ✅, **F10.2 (persisted team structures via F4) ✅ #595**. F10.3 resolution helpers (`manager_of`, `peers_of`, `escalation_chain`) #596 + F10.4 admin UI to view/edit org chart #597 still open. Required by F8 escalation routing and #15 handoff context.
- 🟡 **F11 (2/4)** — Aux-LLM trace-judge framework. Pluggable judge over agent traces, used by #6 leak detection, #8 brand voice, #3.8 risk score, #10 trajectory rating. F11.1 (judge interface + cheap-model dispatch) ✅, **F11.2 (trace preparation: windowed, redacted) ✅ #621**. F11.3 eval-the-judge #622 + F11.4 subscriber pattern #623 remain.

## Cross-cutting additions

Engineering hygiene that ships alongside P0:

- ⬜ **A1** — End-to-end smoke scenario exercising #1 + #2 + #3 + #4 + #5 + #6 in one run.
- ✅ **A2** — `CHANGELOG.md` with manifesto-principle tags per entry.
- ✅ **A3** — Test-fixtures library (agents, clients, threads, secrets).
- ⬜ **A4** — CI cost-regression gate against the eval suite.
- ⬜ **A5** — Threat-model document for any feature touching secrets or keys.

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
