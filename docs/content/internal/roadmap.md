---
title: Trusted Coworker Roadmap
description: Internal product roadmap derived from the Trusted Coworker Manifesto. Not linked from the public docs nav.
---

> **Internal document.** This page is intentionally excluded from the docs sidebar, navigation, and search — but it remains web-accessible by direct URL, which is how GitHub issue bodies reference it. Source of truth for roadmap planning. Tracked in the umbrella issue [HybridAIOne/hybridclaw#466](https://github.com/HybridAIOne/hybridclaw/issues/466).

# Trusted Coworker Roadmap

20 features grouped into three priority tiers. **P0** = Very High Priority (launch package). **P1** = High Priority (depth). **P2** = Priority (breadth). Sequencing within a tier is driven by technical dependencies.

| # | Feature | Description | Priority |
|---|---------|-------------|----------|
| 1 | **Agent-to-agent messaging** | First-class primitive for one coworker to message, hand off, or escalate to another. Persisted envelopes; intent typed; integrates with the hash-chain audit log. | P0 |
| 2 | **Workflow engine — A→B→C with approval gates** | Declarative YAML workflows. Sequential runner, pause/resume on approval, return-for-revision rewinds. Built on top of #1. | P0 |
| 3 | **Coworker scoreboard + auto-`CV.md`** | Per-skill score data model populated from the skill-run event bus. Auto-rendered CV per coworker; admin scoreboard; "best at X" recommendation API. | P0 |
| 4 | **Business-secret masking + demasking** | Extends `confidential-redact.ts` with NDA / client / price / contract classes. Round-trip placeholder scheme; post-LLM rehydrator; mask/demask events on the audit log. | P0 |
| 5 | **Token / money budgets per coworker** | Per-coworker monthly € cap backed by existing `UsageTotals`. Soft-warn at threshold, hard-stop via the policy engine, per-skill sub-limits. | P0 |
| 6 | **NDA / secret-leak classifier** | Classifier on every prompt and response, fed by the skill-run event bus. Block / warn / log via policy engine; eval suite extends the existing harness. | P0 |
| 7 | **Shared enterprise memory** | RAG over team docs / CRM / wiki, available in self-hosted HC. Pluggable vector store, per-coworker source scoping, retrieval-quality eval suite. | P1 |
| 8 | **Brand-voice + output classifier** | Per-tenant voice profile (do / don't, tone, banned phrases). Pre-ship classifier on responses; block / rewrite via policy engine. | P1 |
| 9 | **Hierarchical swarm — HC1 delegates to HC2** | Cross-instance delegation. Signed delegation tokens, transport over HTTP, audit-log linking across instances. | P1 |
| 10 | **Auto fine-tuning on real tasks** | Trajectory capture → PII scrub → per-customer training data → fine-tuning pipeline → tuned-model registry with eval gate before promotion. | P1 |
| 11 | **Coworker working hours + escalation** | Schedule on `AgentConfig` (timezone, weekly hours). Out-of-hours dispatcher decides queue / page / escalate per configured rules. | P1 |
| 12 | **Mobile-first admin (iOS / Android wrapper)** | Responsive admin pages, mobile-friendly approval flow, push notifications, native wrappers via Capacitor or React Native. | P1 |
| 13 | **Per-client cost & audit reports** | Client tagging on activity, per-client cost rollup extending #5, per-client audit-log filter, branded PDF export. | P1 |
| 14 | **SSO + RBAC** | OAuth2 / OIDC framework with Okta, Google Workspace, Microsoft Entra providers. Role + permission model; per-coworker access policies for human users. | P1 |
| 15 | **Coworker handoff with context transfer** | Extends the `handoff` intent from #1 to carry a context bundle (thread refs, brief, client tags). Recipient absorbs context before resuming. | P2 |
| 16 | **Skill A/B testing + canary deployments** | Variant routing by deterministic hash, per-variant metrics from the event bus, statistical comparison, promotion gate via the eval harness. | P2 |
| 17 | **Coworker references / portfolio export** | Anonymized portfolio bundle (work samples + scores). Export and import flows so a coworker template can be instantiated on a fresh instance. | P2 |
| 18 | **Voice / outbound phone channel** | Twilio Programmable Voice for outbound dial. Existing TTS plus STT for callee responses; call-flow primitive; transcript on the audit log. | P2 |
| 19 | **Calendar / meeting presence** | Bot joins Zoom / Meet, real-time STT, live notes, post-meeting summary, action-item dispatch via #1 to other coworkers. | P2 |
| 20 | **Right-to-be-forgotten / GDPR data export** | Identifier registry, cascading data discovery, audited deletion, machine + human readable export. Hash-chain entry of the deletion preserved. | P2 |

---

## Foundations

Cross-cutting work that several roadmap items depend on. Decomposed under the `foundation` label rather than belonging to any single feature.

- **F1** — Extend `AgentConfig` with `owner` / `role` / `cv` fields and persistence. Required by #1, #3, #5, #11.
- **F2** — Unified skill-run event bus (streaming, not post-hoc). Required by #3, #5, #6, #10, #16.
- **F3** — Generalize the network-only policy engine into a "predicate → action" engine. Used by #4, #5, #6, #8, #11, #14.
- **F4** — Versioning + rollback for skills, knowledge, CVs, and classifier weights. Extends `runtime-config-revisions`. Required by Principle VII.
- **F5** — Model pricing & capability matrix on top of `model-catalog`. Required by #5 cost compute and future routing.

## Cross-cutting additions

Engineering hygiene that ships alongside P0:

- **A1** — End-to-end smoke scenario exercising #1 + #2 + #3 + #4 + #5 + #6 in one run.
- **A2** — `CHANGELOG.md` with manifesto-principle tags per entry.
- **A3** — Test-fixtures library (coworkers, clients, threads, secrets).
- **A4** — CI cost-regression gate against the eval suite.
- **A5** — Threat-model document for any feature touching secrets or keys.

---

## How to read this

**P0 (#1–6)** is the launch package. Read it as the smallest set of features that makes the manifesto demonstrable end-to-end:

- #1 + #2 implement Principle IV (coworkers in teams).
- #3 implements Principle I (person, not prompt).
- #4 + #6 implement Principle V (NDA from minute one).
- #5 implements Principle IX (thinks before spending).
- F1 + F2 + F3 are prerequisites for the above.

**P1 (#7–14)** is depth work. Each item compounds with one or more P0 features:

- Shared memory (#7) and auto fine-tuning (#10) close the data flywheel — both feed back into the skill scoreboard (#3) and the leak classifier (#6).
- Hierarchical swarm (#9) extends the A2A primitive (#1) across host instances.
- Working hours (#11), per-client reports (#13), and SSO/RBAC (#14) are operational table stakes once a fleet is in use.
- Mobile admin (#12) is the surface for Principle III on a phone.

**P2 (#15–20)** is breadth. Each item is independently shippable but most depend on at least one P1 item:

- Handoff context transfer (#15) makes #1 + #2 feel finished.
- A/B testing (#16) compounds with #10.
- Voice (#18) and calendar (#19) are channel expansions on top of the existing channel layer.
- RTBF (#20) is the GDPR baseline; mostly implementation work on top of the audit log.

## Sequencing rules

- **Foundations first.** F1, F2, F3 unblock the majority of P0 children. F4 and F5 unblock specific items but are not on the critical path for the launch demo (A1).
- **A2A before workflow.** #1 must ship at least to 1.2 (send/receive runtime API) before #2.2 (sequential runner) becomes useful.
- **Trajectory capture starts early.** 10.1 (trajectory collection) should land alongside F2, well before the rest of #10 — the data is the asset.
- **Leak classifier needs a dataset.** 6.1 (classifier dataset) gates 6.2 / 6.3; budget for labeling time.
- **Avoid net-new channels until P0 ships.** New channel work (#18, #19) is deferred to P2 even where infrastructure exists.

## Out of scope

- Net-new chat channels beyond what already ships in `src/channels/`.
- Generic "more skills" — skills ship through the opinionated business-skill pipeline (Salesforce, HubSpot, SAP, GA4, NL→SQL), not as a feature-count metric.
- Anything that requires the end user to open the desktop app (Principle II).
