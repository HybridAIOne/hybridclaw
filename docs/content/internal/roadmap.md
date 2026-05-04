---
title: Agent, That Really Works — Roadmap
description: Internal product roadmap derived from the HybridClaw manifesto ("The AI Coworker Who's Already On It"). Not linked from the public docs nav.
---

> **Internal document.** This page is intentionally excluded from the docs sidebar, navigation, and search — but it remains web-accessible by direct URL, which is how GitHub issue bodies reference it. Source of truth for roadmap planning. Tracked in the umbrella issue [HybridAIOne/hybridclaw#466](https://github.com/HybridAIOne/hybridclaw/issues/466).

# Agent, That Really Works — Roadmap

Features are grouped into three priority tiers. **P0** = Very High Priority (launch package). **P1** = High Priority (depth). **P2** = Priority (breadth). Sequencing within a tier is driven by technical dependencies.

The roadmap is anchored in the [HybridClaw manifesto — *The AI Coworker Who's Already On It*](../manifesto.md). Numbers in *italic* below each feature link the work back to the principle it serves.

> **Naming convention.** Product, manifesto, and marketing surfaces use **Coworker** (*"hire Lena"*). Code, admin UI, CV, scoreboard, types, and APIs use **Agent**. The two refer to the same entity. This roadmap uses *Agent* in technical descriptions and reverts to *Coworker* when paraphrasing the manifesto. See `docs/content/manifesto.md` for the customer-facing voice.

## Status legend

✅ Done · 🟡 *N/M* partial (children closed/total) · 🔄 PR in flight · ⬜ Not started

| # | Feature | Description | Priority | Status |
|---|---------|-------------|----------|--------|
| 21 | **Business skills and connectors** | Production skills and connector work. See **R21 Production Skills** below for sub-issue rows. *Principle I — the skills are the product.* | P0 | 🟡 3/50 |
| 1 | **Agent-to-agent messaging** | First-class primitive for agents to message, hand off, escalate, federate across instances, and speak multiple transport formats. See **R1 Messaging Work** below for sub-issue rows. *Principle VI.* | P0 | 🟡 4/15 |
| 2 | **Workflow engine — autonomous-by-default with high-stakes escalation** | Declarative YAML workflows. Sequential runner; escalation gates only on high-stakes steps. Return-for-revision rewinds. Built on top of #1. See **R2 Workflow Work** below for sub-issue rows. *Principles II + VI.* | P0 | 🔄 #461 |
| 3 | **Agent scoreboard + auto-`CV.md`** | Per-skill score data model populated from the skill-run event bus. Auto-rendered CV per agent; admin scoreboard; "best at X" recommendation API. See **R3 Scoreboard Work** below for the follow-up row. *Principle IV.* | P0 | ✅ (5/5; follow-up R3.7 ✅ #618; #616, #619 still open) |
| 4 | **Business-secret masking + demasking** | **Substantially built** — round-trip placeholder scheme (`«CONF:RULE_ID»`), `dehydrateConfidential` / `rehydrateConfidential`, streaming-aware rehydrate, scoring + leak scan all live in [`src/security/confidential-redact.ts`](../../../src/security/confidential-redact.ts) + [`confidential-runtime.ts`](../../../src/security/confidential-runtime.ts) + [`confidential-rules.ts`](../../../src/security/confidential-rules.ts). Net-new: (a) first-class `nda` / `price` / `contract` rule kinds (current schema has generic `keyword`/`pattern`), (b) `confidential.dehydrated` / `confidential.rehydrated` audit events. *Principle VII.* | P0 | 🟡 4/6 (round-trip + streaming + scoring shipped; rule-kinds + audit events open) |
| 5 | **Token / money budgets per agent** | Metering substrate done: `UsageTotals` + `monthlySpendUsd()` / `monthlySpendEur()` ([`src/memory/db.ts:3437-3560`](../../../src/memory/db.ts)) + agent-card surfacing. Enforcement remains open. See **R5 Budget Work** below for sub-issue rows. *Principle IX.* | P0 | 🟡 1/6 |
| 6 | **NDA / secret-leak classifier** | **Rule-based offline scanner already shipped** via #406 — [`src/audit/leak-scanner.ts`](../../../src/audit/leak-scanner.ts) (650 lines) reuses `scanForLeaks` from [`confidential-redact.ts:168`](../../../src/security/confidential-redact.ts) with severity/category buckets + CLI. **Inline `post_receive` middleware ✅ via PR #763 (2026-05-01)** — leak scanner now ships as a `ClassifierMiddlewareSkill` adapter with real escalation approvals on `block`, hooked into the executor turn loop. **F3 action mapping ✅ via PR #763** — middleware contract returns `allow` / `block` / `warn` / `transform` / `escalate` and the executor dispatches accordingly. Net-new remaining: (c) optional **F11 LLM-judge fallback** for borderline scores via the F11.4 subscriber pattern, (d) eval suite. *Principle VII.* | P0 | 🟡 3/4 (rule-based scanner ✅ #406; pre-ship hook + F3 action wiring ✅ via PR #763; LLM-judge + eval open) |
| 7 | **Shared enterprise memory** | RAG over team docs / CRM / wiki, available in self-hosted HC. **Substrate already exists**: [`src/memory/`](../../../src/memory/) ships chunker (`chunk.ts`), embeddings (`transformers-embedding-provider.ts`), semantic recall (`semantic-recall.ts`), knowledge graph, consolidation — but agent-scoped, not team-scoped. Net-new: (a) **`source` dimension** on the recall index (agent / team / tenant / external), (b) ingestion CLI for team docs/CRM/wiki sources, (c) per-agent source-scoping policy, (d) retrieval-quality eval suite. **Reuse the existing chunker + embeddings + recall — don't spin up a fresh vector store.** *Principle I.* | P1 | ⬜ (substrate ready) |
| 8 | **Brand-voice + output classifier** | Per-tenant voice profile and pre-ship response classifier. Refactored onto the F8 classifier-middleware contract via PR #763. See **R8 Brand-Voice Work** below for sub-issue rows. *Principle VII.* | P1 | 🟡 3/6 |
| 9 | **Hierarchical swarm — RPC delegation track** | Cross-instance delegation where one instance dispatches a task and awaits a result from another. Shares transport, auth, and audit infrastructure with R1 federation. See **R9 Delegation Work** below for sub-issue rows. *Principle VI.* | P0 | ⬜ 0/6 |
| 10 | **Auto-improvement on real tasks** | Trajectory pipeline feeding two improvement tracks: auto harness evolution and fine-tuning. See **R10 Auto-Improvement Work** below for sub-issue rows. *Principle VIII.* | P1 | 🟡 3/8 |
| 11 | **Operator notification windows + escalation routing** | *Reframed under v3 Principle III.* The coworker is always on; this issue covers per-operator notification preferences (when to page vs. queue for the morning summary) and escalation routing through F8. | P2 | ⬜ (2 anti-principle children closed) |
| 12 | **Mobile-first admin (iOS / Android wrapper)** | Responsive admin pages, mobile-friendly approval flow, push notifications, native wrappers via Capacitor or React Native. *Principle X.* | P1 | ⬜ |
| 13 | **Per-client cost & audit reports** | Client tagging on activity, per-client cost rollup extending #5, per-client audit-log filter, branded PDF export. *Principle VII.* | P1 | ⬜ |
| 14 | **SSO + RBAC** | OAuth2 / OIDC framework with Okta, Google Workspace, Microsoft Entra providers. Role + permission model; per-agent access policies for human users. **Reuse OAuth2 client patterns** already in production at [`src/auth/google-auth.ts:200-290`](../../../src/auth/google-auth.ts) (state param + loopback redirect + token exchange) and [`src/auth/codex-auth.ts:460-550`](../../../src/auth/codex-auth.ts) (PKCE) — these are operator-outbound clients but the same patterns transfer to inbound OIDC. Net-new: inbound OIDC verifier, IdP role mapping, per-user session, permission model, per-agent ACL — **don't re-implement auth-code/PKCE**. *Principle VII.* | P1 | ⬜ |
| 15 | **Agent handoff with context transfer** | Extends the `handoff` intent from #1 to carry a context bundle (thread refs, brief, client tags). Recipient absorbs context before resuming. **Scope discipline (added 2026-04-30):** R15 covers *boundary-crossing* handoffs only — different model tier (Haiku → Opus on stakes), different tenant, or different operator. **Do not** use R15 to split a single coherent task across role-named agents (`Planner → Implementer → Tester`); that is the telephone-game anti-pattern flagged in **R31** coordination-patterns reference. If the receiving agent needs full context, the work belongs in one agent — split only when context can be cleanly separated. *Principle VI.* | P2 | ⬜ |
| 16 | **Skill A/B testing + canary deployments** | Variant routing by deterministic hash, per-variant metrics from the event bus, statistical comparison, promotion gate via the eval harness. *Principle VIII.* | P2 | ⬜ |
| 17 | **Agent references / portfolio export** | Anonymized portfolio bundle (work samples + scores) **plus the evolved harness** — long-term memory, skill packages, tool descriptions, middleware — so an exported coworker can be re-instantiated on a different model/provider without re-evolution. AHE paper ([§4.3](https://arxiv.org/html/2604.25850v1)) showed +5.1–10.1pp gains transferring frozen harnesses to weaker bases; also lifts the floor on **R28** fallback. *Principle IV.* | P2 | ⬜ |
| 18 | **Voice / outbound phone channel** | Outbound HTTP plumbing plus STT/TTS substrate are in place. Agent-facing call operations, call-flow control, audit wiring, and SIP remain open. See **R18 Voice Work** below for sub-issue rows. *Principle V.* | P2 | 🟡 1/5 |
| 19 | **Calendar / meeting presence** | Bot joins Zoom / Meet, real-time STT, live notes, post-meeting summary, action-item dispatch via #1 to other agents. *Principle V.* | P2 | ⬜ |
| 20 | **Right-to-be-forgotten / GDPR data export** | Identifier registry, cascading data discovery, audited deletion, machine + human readable export. Hash-chain entry of the deletion preserved. *Principle VII.* | P2 | ⬜ |
| 22 | **Async voice channel** | **STT + TTS substrate already done** in `src/channels/voice/runtime.ts` (ConversationRelay prompt fragments at lines 440-465 for STT; `responseStream.reply` + `formatTextForVoice` at 344-370 for TTS). Net-new is the **inbound message-layer adapter** — voice notes at the channel-message level rather than a synchronous phone call. Reuse `ConversationRelayResponseStream` + `formatTextForVoice`. *Principle V.* | P2 | 🟡 (STT/TTS ✅; message adapter open) |
| 23 | **Whole-instance backup + restore (disaster recovery)** | `hybridclaw backup` + `restore` CLI for WAL-safe SQLite snapshot + zip-archive re-hydration on a fresh host. *Principle VII.* | P1 | ✅ #635 (via PR #428) |
| 24 | **SMS channel via European operator APIs** | Pluggable SMS provider via the existing channel layer — Telekom MMS API, Vodafone Messaging, 1&1 SMS gateway. For transactional B2B messaging (OTPs, alerts) where WhatsApp/Telegram aren't the right modality. **Reuse** Twilio account/auth plumbing from [`src/channels/voice/twilio-manager.ts`](../../../src/channels/voice/twilio-manager.ts) for the Twilio-SMS stopgap path. Add `sms` to `ChannelKind` at [`src/channels/channel.ts:1-13`](../../../src/channels/channel.ts) and a new `src/channels/sms/` runtime. *Principle V.* | P2 | ⬜ |
| 25 | **EU deployment recipes (Hetzner / IONOS / Open Telekom Cloud)** | Operator guides for deploying HybridClaw on each EU cloud provider — Docker Compose, Terraform, secret-store setup, F6-tunnel vs cloud-native ingress, backup wiring (R23). DSGVO talking points for sales. *Principle X.* | P1 (Hetzner) / P2 (IONOS, OTC) | ⬜ |
| 26 | **Fax gateway + outbound skill** | Inbound fax-to-email → existing email channel; outbound fax-send skill with pluggable EU-resident provider (Telekom Cloud Fax / Sinch / Vodafone Fax2Mail / T.38 over R18.7 SIP). *Principle V — DACH B2B Steuerberater + healthcare + legal workflows.* | P2 | ⬜ |
| 27 | **Async tamper-evident token-usage buffer** | Producer-consumer queue decouples model invocations from synchronous chargeback DB writes; periodic batch flush emits SHA-256-hashed `usage.batch_flushed` audit events. Substrate for R5.x at scale. *Principle VII.* | P1 | ✅ #663 (via PR #467) |
| 28 | **Provider fallback chain (resilience)** | Auth (401/403) → immediate switch; rate-limit (429) → switch + cooldown on primary-leave only; streaming-safe; configured via `HYBRIDAI_FALLBACK_CHAIN`. Implementation at [`src/gateway/provider-fallback.ts`](../../../src/gateway/provider-fallback.ts) (`classifyProviderError`, `tryActivate` with `leavingPrimary` guard, `shouldFallback` streaming gate). *Principle VIII — doesn't break overnight when a provider has an outage.* | P1 | ✅ #413 (merged in `0648606e`) |
| 29 | **Kanban-style admin work board** [#687](https://github.com/HybridAIOne/hybridclaw/issues/687) | Coworker workboard at `/admin/board`: columns Triage → Todo → In Progress → In Review → Done (per-column auto-merge toggle). Per-card surface mirrors the Fusion job-board reference — sub-task progress bar + collapsible step list with strikethrough on completed steps, model badge (Opus/Sonnet/Haiku), files-changed count, worktree pill, linked-task chips, status pills (specifying / paused / merging / queued / blocked), live activity ticker, footer counters (running M/N · blocked · queued · in-review). Subsumes the workflow state visualizer (R2.5 [#434](https://github.com/HybridAIOne/hybridclaw/issues/434)) and the admin inbox (R1.3 [#426](https://github.com/HybridAIOne/hybridclaw/issues/426)) into one surface; feeds the F2 event bus to update without polling. **Dual use (added 2026-04-30):** the same card data model + F2 event stream is the **shared task list** for **R31** agent-team coordination — agents claim cards via R1 envelopes, surface `blockedBy` + dependency edges, and the human-ops view and agent-team view read the same store. *Principles IV + X.* | P1 | ⬜ |
| 30 | **Browser channel/skill ([browser-use](https://github.com/browser-use/browser-use) integration)** [#700](https://github.com/HybridAIOne/hybridclaw/issues/700) | Browser automation substrate with local, managed-cloud, and browser-use-cloud install modes. Session persistence reuses the existing browser profile convention; browser actions must respect F13 credential injection and F14 2FA handover. See **R30 Browser Work** below for sub-issue rows. *Principles V + VII.* | P1 | 🟡 3/10 |
| 31 | **Coordination patterns reference + worked examples** [#704](https://github.com/HybridAIOne/hybridclaw/issues/704) | Names the **two coordination architectures** HybridClaw supports and maps them to existing primitives so skill authors pick correctly: **(1) Sub-agents** — isolated, one-shot, parent-controlled, returns compressed result. Substrate: Claude Agent SDK `Agent` tool with `subagent_type` (already in use by the harness itself). Right when sub-tasks are independent and the parent only needs the final answer (vision-extract, code-review, eval-runner). **(2) Agent teams** — persistent, peer-to-peer, shared task layer. Substrate: **R1** A2A envelopes (peer comms) + **F10** org chart (`peers` / `delegates_to`) + **R29** kanban board as the shared task list (claim/release/`blockedBy`). Right when work has cross-cutting dependencies and agents need to coordinate live. **Decomposition rule:** *split by what an agent needs to know, not by what role it plays* — role-named pipelines (`Planner → Implementer → Tester`) lose information at every handoff (anti-pattern, see R15 scope discipline). Also documents the **five orchestration patterns** (prompt chaining, routing, parallelization, orchestrator-worker, evaluator-optimizer) and maps each to existing or planned primitives: routing → F8 stakes classifier; orchestrator-worker → sub-agents; evaluator-optimizer → R10a harness evolution loop. Deliverable: a section in `docs/content/developer-guide/` with worked examples (browser skill spawning a vision sub-agent for screenshot OCR; multi-agent feature build using R29 task list + R1 envelopes) and a decision tree ("does the receiver need the parent's reasoning? if yes, don't split"). Added 2026-04-30. *Principles IV + VI.* | P1 | ⬜ |
| 32 | **Server maintenance skill — local execution** *(to be filed)* | A persistent agent role with **local shell + systemd + log + filesystem-inspection** capabilities, designed for HybridClaw deployed *on* the target server (chat-ops). Operator talks to it through any existing channel ("why is disk full?", "restart nginx", "tail the auth log"). Skill bundle: `journalctl` reader, `systemctl status/restart/reload`, `df` / `du` / `free` / `top`, `/var/log` tail with leak-scanner ([R6](#)) over outbound responses, package-manager reads, no `apt install` / `rm -rf` without F8 stakes-escalation + F14 operator-confirm. **Reuses:** existing channels, [F8](#) stakes classifier, [F14](#) escalation, [R29](#) board (incidents as cards), [R31](https://github.com/HybridAIOne/hybridclaw/issues/704) sub-agent pattern (parent dispatches isolated log-readers without polluting context). [R14](#) RBAC scopes per-host shell access; [F13](https://github.com/HybridAIOne/hybridclaw/issues/698) audits any credential read. Pairs with [R25](#) EU deployment recipes — every Hetzner / IONOS / OTC deployment ships R32 by default so operators get chat-ops out of the box. Added 2026-04-30. *Principles III + V.* | P1 | ⬜ |
| 33 | **Server maintenance skill — remote SSH** *(to be filed)* | Companion to [R32](#) for the case where HybridClaw runs centrally and reaches one or more managed hosts via SSH. Skill bundle: SSH session pool with per-host `known_hosts` + per-host policy, the same shell/systemd/log surface as R32 but executed remotely, file pulls (sftp), interactive `sudo` flows that escalate to F14 instead of auto-typing the password. **SSH keys are exactly the use case [F13](https://github.com/HybridAIOne/hybridclaw/issues/698) was designed for** — keys reference by `SecretRef`, never returned as a string, never typed into the LLM context. **Reuses:** F13 keystroke-injection pattern (extended from DOM to SSH stdin), [F3](#) per-host ACL predicates (`ssh_exec_allowed`), R14 RBAC, R29 board, R31 sub-agent pattern. **Out of scope:** rolling out config-as-code (that's a different Ansible/Terraform-shaped skill). R33 is interactive ops, not declarative provisioning. Added 2026-04-30. *Principles III + V + VII.* | P1 | ⬜ |
| 34 | **Local-LLM teammate / sovereign delegation** *(to be filed)* | Extends [R9](#) hierarchical swarm so a HybridAI-cloud or self-hosted instance can **delegate to a peer instance running a strong local LLM** (Llama-3.3-70B / Mixtral 8x22B / Qwen2.5-72B / etc. via Ollama / vLLM / TGI / LM Studio) for tasks that must not leave the operator's network. Net-new layers on top of existing R9 + F5 + F10 substrate: **(a) capability advertisement** — peer instances publish their local models into [F5](#) capability matrix (`provider: local`, `host: peer-id`, model + context window + GPU class); **(b) residency / sovereignty policy** via [F3](#) — a skill or task can declare `data_residency: local-only` and the router refuses to dispatch to any cloud provider; **(c) routing layer** — F8/F5 picks a peer that satisfies the policy and has the capability, falling back to operator escalation (F14) if no peer is reachable. **Reuses:** R9 cross-instance delegation tokens + transport ([PR #409](https://github.com/HybridAIOne/hybridclaw/pull/409)), F5 capability matrix (currently per-provider, extends to per-peer-instance), F10 `delegates_to`, R28 fallback chain (peer outage → next peer or escalate). **Composes with R32 / R33** — a maintenance agent on a sovereign-data server can keep logs out of the cloud entirely by handing the LLM step to a local-LLM peer. **Composes with R31** — the sub-agent pattern is what runs on the local-LLM peer (parent on cloud, isolated worker on local). Added 2026-04-30. *Principles VII + VIII.* | P1 | ⬜ |
| 35 | **LLM Council mode — multi-provider deliberation** [#711](https://github.com/HybridAIOne/hybridclaw/issues/711) | Concurrent fan-out across providers, anonymized cross-critique, and chairman synthesis gated by F8 stakes and R5 budget controls. See **R35 Council Work** below for sub-issue rows. *Principles I + IV + VII.* | P1 | ⬜ |
| 36 | **WhatsApp Cloud API channel** [#734](https://github.com/HybridAIOne/hybridclaw/issues/734) | Inbound + outbound via Meta's WhatsApp Cloud API (direct integration, not Twilio's wrapper). Add `whatsapp` to `ChannelKind` at [`src/channels/channel.ts:1-13`](../../../src/channels/channel.ts) and a new `src/channels/whatsapp/` runtime. Registered as **F14** escalation modality so `escalation.interaction_needed` events route to operator phone numbers; quick-reply / text replies (`approve` / `deny` / `yes for session`) feed `handleApprovalResponse` in [`container/src/approval-policy.ts`](../../../container/src/approval-policy.ts) via the same regex path used by terminal approvals. Per-tenant config (business account ID + phone number ID + access token + designated operator numbers); opt-in template messages for the 24-hour window rule; audit-log entries record channel + counterpart phone number on every approval. Driver: WhatsApp is the dominant messaging modality in DACH / LATAM / most of EMEA — for many operators it's where they'd see and respond to an approval ping fastest. Composes with **F14** + **F10** + **R12** + **R37** (Discord peer for ops-team approvals). Added 2026-05-01. *Principle V.* | P2 | ⬜ |
| 37 | **Discord channel + slash-command approval** [#735](https://github.com/HybridAIOne/hybridclaw/issues/735) | Bot-user channel for engineering / ops teams that live in Discord. Add `discord` to `ChannelKind` at [`src/channels/channel.ts:1-13`](../../../src/channels/channel.ts) and a new `src/channels/discord/` runtime. Slash commands `/approve <id>`, `/deny <id>`, `/trust agent <name> <action>`, `/list-pending` feed `handleApprovalResponse` in [`container/src/approval-policy.ts`](../../../container/src/approval-policy.ts). **F14** escalation registration routes `escalation.interaction_needed` events to a configured ops channel + role mention; each escalation creates its own thread so back-and-forth doesn't pollute the channel. Per-guild config (bot token, ops channel ID, role ID, channel allowlist for sensitive escalations); audit records guild ID + channel ID + Discord user ID per approval. Peer to **R36**: WhatsApp targets the individual operator, Discord targets the team channel — both worth shipping. Composes with **F14** + **F10** + **R29** (a `In Review` card mirrors a pending Discord thread) + **R36**. Anti-goal: not a generic Discord-to-LLM bridge for end users. Added 2026-05-01. *Principle V.* | P2 | ⬜ |
| 38 | **Microsoft Teams channel** | Bot adapter for the Microsoft Teams platform — proactive messaging, mentions, file / image delivery, approval surface (Adaptive Cards). **Already shipped** at [`src/channels/msteams/`](../../../src/channels/msteams/) (`runtime.ts`, `delivery.ts`, `inbound.ts`, `prompt-adapter.ts`, `retry.ts`, `send-permissions.ts`, `stream.ts`, `tool-actions.ts`, `typing.ts`); registered in [`src/channels/channel-registry.ts`](../../../src/channels/channel-registry.ts) with `MSTEAMS_CAPABILITIES`. Filed retroactively after the channel-registry audit on 2026-05-02 surfaced that MS Teams shipped without a roadmap row — included for status-snapshot completeness alongside R36 / R37. B2B-critical for DACH alongside R36 WhatsApp. Composes with **F14** as escalation modality. *Principle V.* Added 2026-05-02. | P1 | ✅ (already shipped) |
| 39 | **Matrix channel — sovereign / EU positioning** | Matrix client adapter (Element / Synapse / self-hosted homeservers). Reaction-based exec approval (operator drops a ✅ on the prompt — same UX pattern as Slack reactions but on a stack the customer can self-host), DM auto-threading, configurable home room. Pairs with **R25** EU deployment recipes for the sovereign-stack story — Matrix homeservers self-host alongside HybridClaw on Hetzner / IONOS / Open Telekom Cloud, no third-party comms vendor in the loop. **F15 prereq** — the in-repo `channel-registry.ts` is currently a hardcoded `Record<ChannelKind, ChannelInfo['capabilities']>` over the existing kinds; Matrix can't be added without unhardcoding it. Composes with **F14** as escalation modality + **R25** EU deployment + **F10** org-chart routing. *Principle V.* Added 2026-05-02. | P1 | ⬜ |
| 40 | **Persistent cross-turn goal primitive (`/goal`)** | Operator-set objective the agent pursues across turns until met or cancelled. Sits between **R2** declarative YAML workflows (rigid, author-defined) and **R29** kanban cards (operator-authored, human-claimed). State persisted alongside the thread; re-injected into every turn header until the agent emits `goal.completed` on **F2** (judged by **F11**) or the user cancels with `/goal cancel`. **High-stakes goal steps still escalate normally via F8** — the goal primitive is intent-persistence, not autonomy-elevation. The cheapest *"act first, asks later"* surface that doesn't make the operator write workflow YAML; complements R2 by covering the open-ended-objective end of the spectrum (R2 covers structured multi-step processes, R40 covers *"keep going until it's done"*). Composes with **F8** + **F11** + **R29** (goals optionally surface as cards) + **R44** achievements (completing a goal can fire a milestone). *Principles II + IV.* Added 2026-05-02. | P1 | ⬜ |
| 41 | **Background skill-maintenance loop** | Cron-thread-driven curator that runs unattended (overnight by default) to consolidate duplicate skills, prune unused skills (no run in N days), and reclassify archived skills as *"consolidated"* vs *"pruned"* with reason strings. Reuses **F2** events (skill-run frequency telemetry feeds the consolidation decisions), **F4** versioning (every consolidation is a versioned edit, fully rollback-able), **R10.1** trajectories (which skill produced which result), **F11** trace-judge (decides whether two near-duplicate skills should merge). Surface: `runtime/curator/<run-id>/run.json` (machine-readable for **R10a** harness-evolution) + `REPORT.md` (human-readable for the operator). Concrete demonstration of Principle III (*"doesn't clock out"*) that doesn't need a customer task to fire — a coworker tidying its own catalog while the team sleeps. **Anti-pattern to avoid:** agentic background loops that consume budget without producing an operator-visible artifact — every run **must** produce a report, every consolidation **must** be reversible via F4. *Principles III + VIII.* Added 2026-05-02. | P1 | ⬜ |
| 42 | **Live model picker with inline credential setup** | Operator UX inside the chat: picker lists configured + unconfigured providers (model list merged from **F5** capability matrix), paste-API-key-inline registers an unconfigured provider on the spot, `d`-keybind disconnects a configured provider, switch model without leaving the conversation. Generalizes **F6.8** (admin UI for tunnel provider config) — same *"configure-without-leaving-the-conversation"* pattern, different resource. Closes one of the load-bearing gaps in **Principle X** (*"hired in sixty seconds"*) on the model-config side: today, switching providers means editing config files. **Reuse:** OAuth / PKCE patterns already in production at [`src/auth/google-auth.ts:200-290`](../../../src/auth/google-auth.ts) + [`src/auth/codex-auth.ts:460-550`](../../../src/auth/codex-auth.ts) for OAuth providers; API-key-paste flow for plain-key providers. Composes with **F5** (catalog source-of-truth) + **R28** fallback-chain CLI peer + **F6.8** admin-UI extension + **F17** managed-policy convention (the inline credential paste should auto-write the provider's policy grant via the same shared helper R45 uses, not reinvent the rule-placement logic). *Principles VIII + X.* Added 2026-05-02. | P1 | ⬜ |
| 43 | **Computer-use track (sibling to R30 browser)** | Universal any-model schema for OS-level UI control — mouse / keyboard / window focus / `set_value` / structured-window enumeration / MIME detection on drops. **Distinct from R30's browser-DOM track:** R30 controls a browser via Playwright; R43 controls the host's UI via a CUA driver. **Background focus-safe mode** so the agent never steals the operator's foreground while it works (the operator-still-driving constraint that browser sessions don't have). **F13 credential injection** extends from DOM elements to OS-level password fields — same opaque-handle discipline. Composes with **R32** (chat-ops on the deployed host can use UI tools when CLI isn't enough), **R30** (CUA as fallback when a SaaS lacks an HTTP API and JS-DOM control is too brittle), and **F14** (any UI flow that hits a 2FA prompt parks via F14, same as the browser path). Sequencing: P1 once R30.2 ships — same `BrowserProvider`-style interface but a different action vocabulary and a different transport, so the provider seam should be designed once. *Principles V + VII.* Added 2026-05-02. | P1 | ⬜ |
| 44 | **Achievements / track-record surface** | User-facing layer over **R3** scoreboard data — scan session history for milestones (first ticket closed, N-th deal won, M-day streak, biggest-wins-in-skill-X) and render as medals on the agent card alongside the per-skill scores already in [`src/skills/agent-cv.ts`](../../../src/skills/agent-cv.ts) / [`src/skills/agent-scoreboard.ts`](../../../src/skills/agent-scoreboard.ts). Closes the *"name, face, voice, CV, references"* loop in **Principle IV** — current R3 ships the *data*, R44 ships the *colleague experience*. Implementation: F2 event subscriber that produces achievement records on milestone triggers; render hook on the existing CV surface; configurable milestone definitions per tenant. Composes with **R3** scoreboard (data source) + **F2** (event-driven trigger) + **R40** `/goal` (goal completion as a milestone class). *Principle IV.* Added 2026-05-02. | P2 | ⬜ |
| 45 | **Connector setup ergonomics — auto-grant on add, auto-revoke on remove** | Operator-facing roll-out of the **F17** `managed_by_*` policy convention across every "I added a credential, now I have to write yaml" path. **First instance shipped** by [PR #784](https://github.com/HybridAIOne/hybridclaw/pull/784): `hybridclaw secret route add` now writes both the runtime auth-rule *and* the matching `secret_resolve_allowed` policy grant, scoped to host + header + secret + agent, removable in one step. R45 extends the same pattern to: **(a) [#786](https://github.com/HybridAIOne/hybridclaw/issues/786)** `hybridclaw mcp add` (CLI + inline `/mcp add`) — writes the MCP server entry plus per-tool `mcp_tool_allowed` managed rules per discovered tool, scoped to the requesting agent; **(b) [#787](https://github.com/HybridAIOne/hybridclaw/issues/787)** skill install — `SKILL.md` frontmatter declares the credential scopes the skill needs (secret IDs + host / selector + side: DOM keystroke per **F13** vs HTTP header), install prompts inline for missing creds and auto-writes the matching F3 grants, upgrade diffs them, remove cleans them up; **(c) [#788](https://github.com/HybridAIOne/hybridclaw/issues/788)** channel registration — `hybridclaw channel add <kind>` (CLI + inline `/channel add`) prompts for the channel-specific bundle (bot token + channel ID + role ID + allowlist) and writes the narrow inbound + outbound + escalation grants. **Composes with [R42](#)**: the live model picker is the same convention applied to providers — call it out here so R42 implementation reuses the F17 helper instead of reinventing the rule placement. **Trust boundary held**: every managed rule stays narrow (no wildcards), audit log records the connector that wrote it, deny-by-default still applies. **Driver**: every new connector type today re-introduces a yaml-editing step that violates Principle X — R45 is the durable closure. *Principles VII + X.* Added 2026-05-02. | P1 | 🟡 1/4 (HTTP secret route ✅ via PR #784; MCP / skill / channel open) |
| 46 | **Threema channel — Swiss-sovereign / DACH-regulated positioning** | Threema Gateway API integration (HTTPS REST + end-to-end NaCl encryption) for inbound + outbound business messaging on the Swiss-hosted, GDPR-native messenger. Targets DACH-regulated verticals where WhatsApp is a non-starter (healthcare, legal, public sector, finance) and where Matrix self-hosting is too operational a lift — Threema Work gives a managed sovereign comms surface customers already deploy. Add `threema` to `ChannelKind` at [`src/channels/channel.ts:1-13`](../../../src/channels/channel.ts) and ship as a plugin under `src/plugins/` once **F15** lands (per the plugin-first channel rule); pre-F15 a thin `src/channels/threema/` runtime is acceptable as the seam-exerciser. Per-tenant config (Gateway ID + API secret + private NaCl key resolved via **F13** `SecretRef` — the private key is exactly the never-typed-into-LLM-context case F13 was designed for); inbound delivery callback verifies HMAC-SHA256 over the message envelope; outbound message-send routes via `formatTextForVoice`-equivalent text adapter. Registered as **F14** escalation modality so `escalation.interaction_needed` events route to a configured operator Threema ID; reply-text approvals (`approve <id>` / `deny <id>`) feed `handleApprovalResponse` in [`container/src/approval-policy.ts`](../../../container/src/approval-policy.ts) via the same regex path used by other text channels; audit-log entries record Gateway ID + counterpart Threema ID per approval. **Pairs with [R25](#)** EU deployment recipes — every Hetzner / IONOS / OTC deployment can ship a Threema-Gateway-only escalation modality without any non-EU vendor in the loop, complementing **R39** Matrix for full-stack sovereignty stories. **Composes with F14 + F10 + R12 + R25 + R39 + R45 #788** (channel add auto-grants the narrow inbound/outbound/escalation rules through the F17 helper). Anti-goal: not an end-user Threema bot for consumer support — Threema's per-message pricing makes it operator/escalation-modality only, not high-volume customer-facing. Added 2026-05-04. *Principle V.* | P1 | ⬜ |

## R21 Production Skills

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Type | Title | Status |
|----|------|-------|--------|
| R21.1 | Foundation | TypeScript SKILL.md framework | ✅ Done |
| R21.1.1 | Foundation | NexAU-style skill package support | ⬜ To be filed |
| R21.2 | Skill | Salesforce skill | ✅ Done |
| R21.3 | Skill | HubSpot skill | ⬜ To be filed |
| R21.4 | Skill | SAP ERP skill | ⬜ To be filed |
| R21.5 | Skill | GA4 skill | ⬜ To be filed |
| R21.6 | Skill | NL-to-SQL warehouse skill | ✅ Done #584 via PR #679 |
| R21.7 | Skill | Hetzner DevOps skill | ⬜ To be filed |
| R21.8 | Skill | SAP Analytics Cloud skill | ⬜ To be filed |
| R21.9 | Skill | DATEV skill | ⬜ To be filed |
| R21.10 | Skill | Lexware Office skill | ⬜ To be filed |
| R21.11 | Skill | Invoice harvester skill | 🟡 #688; API adapters via PR #772 |
| R21.11.1 | Skill | Invoice harvester browser scrape adapters | ⬜ #778 |
| R21.12 | Skill | ELSTER skill | ⬜ #689 |
| R21.13 | Skill | XRechnung/ZUGFeRD/Peppol skill | ⬜ #690 |
| R21.14 | Skill | HBCI/FinTS skill | ⬜ #691 |
| R21.15 | Skill | Handelsregister/Bundesanzeiger skill | ⬜ #692 |
| R21.16 | Skill | Schufa/Creditreform skill | ⬜ #693 |
| R21.17 | Skill | Celonis skill | ⬜ #722 |
| R21.18 | Skill | Personio skill | ⬜ #723 |
| R21.19 | Skill | FastBill skill | ⬜ #724 |
| R21.20 | Skill | Google Ads skill | ⬜ To be filed |
| R21.21 | Skill | SAP Utilities maintenance skill | ⬜ To be filed |
| R21.22 | Skill | OT cybersecurity skill | ⬜ To be filed |
| R21.23 | Skill | Energy-infrastructure project-management skill | ⬜ To be filed |
| R21.24 | Skill | IT demand-management skill | ⬜ To be filed |
| R21.25 | Skill | BIM infrastructure-documentation skill | ⬜ To be filed |
| R21.26 | Skill | Plant lifecycle technical-standards skill | ⬜ To be filed |
| R21.27 | Skill | Commercial legal-governance skill | ⬜ To be filed |
| R21.28 | Skill | Finance close-and-reporting skill | ⬜ To be filed |
| R21.29 | Skill | Payroll accounting skill | ⬜ To be filed |
| R21.30 | Skill | Order-to-cash skill | ⬜ To be filed |
| R21.31 | Skill | Record-to-report skill | ⬜ To be filed |
| R21.32 | Skill | Product-design research skill | ⬜ To be filed |
| R21.33 | Skill | Market-research analytics skill | ⬜ To be filed |
| R21.34 | Plugin | Workday HR/payroll read connector | ⬜ To be filed |
| R21.35 | Plugin | Finance-system connector for close, OTC, and R2R workflows | ⬜ To be filed |
| R21.36 | Plugin | CLM/document-repository connector for legal review | ⬜ To be filed |
| R21.37 | Plugin | Figma/design-system connector for product design | ⬜ To be filed |
| R21.38 | Skill | Event guest-relation management skill | ⬜ To be filed |
| R21.39 | Skill | Event microsite publishing skill | ⬜ To be filed |
| R21.40 | Skill | 360 campaign project-control skill | ⬜ To be filed |
| R21.41 | Skill | Pitch-deck and presentation narrative skill | ⬜ To be filed |
| R21.42 | Skill | Brand copywriting QA skill | ⬜ To be filed |
| R21.43 | Skill | Social-first campaign ideation skill | ⬜ To be filed |
| R21.44 | Skill | Photo/video production planning skill | ⬜ To be filed |
| R21.45 | Skill | AI-assisted creative-production governance skill | ⬜ To be filed |
| R21.46 | Skill | Digital product sales-monitoring skill | ⬜ To be filed |
| R21.47 | Plugin | Adobe Creative Cloud asset connector | ⬜ To be filed |
| R21.48 | Plugin | ATS job-posting connector | ⬜ To be filed |
| R21.49 | Skill | Deutsche Bahn business-travel skill (schedule lookup, ticket booking, BahnCard expense reconciliation) | ⬜ To be filed |
| R21.50 | Skill | Lufthansa business-travel skill (NDC booking, status/frequent-flyer lookup, irregular-ops rebooking) | ⬜ To be filed |
| R21.51 | Skill | Workday HR-workflow skill (onboarding, time-off, expense, review prep — consumes R21.34 connector) | ⬜ To be filed |

## R1 Messaging Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R1.1 | Core | Persisted A2A envelope store | ✅ Done |
| R1.2 | Core | A2A send-message primitive | ✅ Done #425 via PR #695 |
| R1.3 | Admin | Admin inbox surface for inbound agent work | ⬜ #426 |
| R1.5 | Audit | Hash-chain audit-log integration for saved A2A envelopes | ⬜ #429 |
| R1.6 | Federation | Cross-instance routing in `sendMessage` | ⬜ #717 |
| R1.7 | Federation | Inbound peer endpoint | ⬜ #718 |
| R1.8 | Federation | Envelope schema additions for cross-instance routing | ⬜ #719 |
| R1.9 | Federation | Operator pairing UX | ⬜ #720 |
| R1.10 | Transport | Transport registry and peer descriptor schema | ✅ #765 via PR #777 |
| R1.11 | Transport | A2A outbound adapter | ⬜ #766 |
| R1.12 | Transport | A2A inbound adapter and Agent Card endpoint | ⬜ #767 |
| R1.13 | Transport | Signed-HMAC webhook outbound adapter with retry and jitter | ✅ #768 via PR #782 |
| R1.14 | Transport | Signed-HMAC webhook inbound adapter | ⬜ #769 |
| R1.15 | Transport | A2A streaming SSE for R9 RPC delegation responses | ⬜ #771 |

## R2 Workflow Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R2.1 | Workflow | Declarative YAML workflow schema | 🔄 #461 |
| R2.2 | Workflow | Sequential workflow runner | 🔄 #461 |
| R2.3 | Policy | High-stakes gating semantics through F8 default action | ⬜ To be filed |
| R2.4 | Workflow | Return-for-revision rewind behavior | ⬜ To be filed |
| R2.5 | Admin | Workflow state visualizer | ⬜ #434 |

## R3 Scoreboard Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R3.7 | Scoreboard | Scoreboard follow-up from shipped CV work | ✅ #618 |

## R5 Budget Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R5.1 | Metering | Usage totals and monthly spend surfacing | ✅ Done |
| R5.2 | Enforcement | Soft-warn spend threshold | ⬜ To be filed |
| R5.3 | Enforcement | Hard-stop policy predicate consuming `monthlySpendUsd` | ⬜ To be filed |
| R5.4 | Enforcement | Per-skill budget sub-limits | ⬜ To be filed |
| R5.5 | Admin | Budget admin surface | ⬜ To be filed |
| R5.6 | Audit | Budget warning and enforcement audit events | ⬜ To be filed |

## R8 Brand-Voice Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R8.1 | Classifier | Brand-voice profile schema | ✅ Done |
| R8.2 | Classifier | Response classifier integration | ✅ Done |
| R8.3 | Middleware | Brand-voice middleware adapter | ✅ PR #408, refactored via PR #763 |
| R8.4 | Admin | Brand-voice profile editor | ⬜ #477 |
| R8.5 | Channels | Per-channel voice variants | ⬜ #478 |
| R8.6 | Policy | Gate enforcement config for brand-voice middleware | ⬜ #682 |

## R9 Delegation Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R9.1 | Auth | Inter-instance authentication with signed tokens | ⬜ #480 |
| R9.2 | Delegation | Delegation envelope schema | ⬜ #481 |
| R9.3 | Transport | Cross-instance HTTP transport | ⬜ #482 |
| R9.4 | Audit | Cross-instance audit-log linking | ⬜ #483 |
| R9.5 | Admin | Fleet topology admin UI | ⬜ #484 |
| R9.6 | Reliability | Failure handling for offline child instances | ⬜ #486 |

## R10 Auto-Improvement Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R10.1 | Trajectories | Store skill-run trajectories as filesystem JSONL under `<runtime>/trajectories/` | ✅ Done |
| R10.2 | Trajectories | Rate and prepare trajectories for improvement loops | ✅ Done |
| R10.3 | Trajectories | Feed trajectory ratings into skill scoring | ✅ Done |
| R10.4 | Fine-tuning | Per-tenant SFT dataset builder | ⬜ To be filed |
| R10.5 | Fine-tuning | Eval-gated SFT promotion workflow | ⬜ To be filed |
| R10.6 | Fine-tuning | Tenant-specific model registry and rollback | ⬜ To be filed |
| R10.7 | Fine-tuning | Fine-tuning audit and cost reporting | ⬜ To be filed |
| R10.8 | Harness evolution | Auto harness evolution loop gated by F12 manifest predictions | ⬜ #686 |

## R18 Voice Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R18.1 | Voice | Outbound HTTP call plumbing | ✅ Done |
| R18.2 | Voice | Agent-facing outbound-call tool or skill | ⬜ To be filed |
| R18.3 | Voice | Call-flow primitive | ⬜ To be filed |
| R18.4 | Audit | Transcript-to-audit-log wiring | ⬜ To be filed |
| R18.7 | Voice | SIP outbound support for operators with PBX/SIP trunks | ⬜ To be filed |

## R30 Browser Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R30.1 | Browser substrate | `BrowserProvider` interface and action vocabulary | ✅ #749 via PR #761 |
| R30.2 | Local provider | Local Playwright provider using persistent browser context | ✅ #750 via PR #783 |
| R30.3 | Managed provider | Managed-cloud browser provider with shared navigation guard | ⬜ To be filed |
| R30.4 | Passthrough provider | Browser-use cloud passthrough with metering and audit URLs | ✅ #752 via PR #792 |
| R30.5 | Sessions | Browser profile persistence and container mount integration | ⬜ To be filed |
| R30.6 | Credentials | F13 keystroke-injection wiring for browser fills | ⬜ To be filed |
| R30.7 | Escalation | F14 2FA handover for browser sessions | ⬜ To be filed |
| R30.8 | Policy | Per-host and per-selector browser policy checks | ⬜ To be filed |
| R30.9 | Audit | Browser session event and screenshot audit trail | ⬜ To be filed |
| R30.10 | Evals | Browser automation eval gate and install-mode promotion checks | ⬜ To be filed |

## R35 Council Work

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| R35.1 | Runtime | Council fan-out, critique, and synthesis primitive | ⬜ To be filed |
| R35.2 | Policy | F8-gated activation with R5 budget accounting | ⬜ To be filed |
| R35.3 | Judge | Council-as-judge subscriber for borderline classifier decisions | ⬜ To be filed |
| R35.4 | Admin | R29 board surface for model disagreement | ⬜ To be filed |
| R35.5 | Export | R17 portfolio export of council model configuration | ⬜ To be filed |
| R35.6 | Evals | Council-vs-single-model eval suite | ⬜ To be filed |

---

## Foundations

Cross-cutting work that several roadmap items depend on. Decomposed under the `foundation` label rather than belonging to any single feature.

- ✅ **F1** — Extend `AgentConfig` with `owner` / `role` / `cv` fields and persistence. `owner` is a typed reference to a canonical user (see F7). Required by #1, #3, #5, #11, #21.
- ✅ **F2** — Unified skill-run event bus (streaming, not post-hoc). Required by #3, #5, #6, #10, #16, F8. **Hook vocabulary** is enumerated in `PluginHookName` at [`src/plugins/plugin-types.ts`](../../../src/plugins/plugin-types.ts) — 14 named hooks cover session / prompt / agent / tool / compaction / memory / gateway lifecycle. **Three additions pending** for the approval-cascade and dispatch surfaces (driven by **F8.9** and the **R29** board's per-card live counters): `before_approval_request`, `after_approval_response`, `gateway_inbound_dispatch`. Lock the wire shape before R6 / R8 / R10a / R29 subscribers diverge.
- ✅ **F3** — Generalize the network-only policy engine into a "predicate → action" engine. Used by #4, #5, #6, #8, #14, F8.
- ✅ **F4** — Versioning + rollback for skills, knowledge, CVs, and classifier weights. Extends `runtime-config-revisions`. Required by Principle VII.
- ✅ **F5** — Model pricing & capability matrix on top of `model-catalog`. Required by #5 cost compute and future routing.
- 🟡 **F6** — Deployment-mode + public-URL abstraction. See **Foundation Sub-Issues** below for F6 rows.
- 🟡 **F7** — Global identity primitives. Agent-ID format, canonical user IDs, and local instance-ID allocation are in production ([`src/identity/agent-id.ts`](../../../src/identity/agent-id.ts), [`src/identity/user-id.ts`](../../../src/identity/user-id.ts), and F7.1 ✅ via PR #776); cross-instance resolver and TOFU trust remain. See **Foundation Sub-Issues** below for F7 rows.
- 🟡 **F8** — Autonomy + escalation policy framework. Stakes classification and escalation routing are substantially shipped; policy-pipeline work remains. See **Foundation Sub-Issues** below for F8 rows.
- 🟡 **F9** — Always-on runtime guarantees. Warm process pool and liveness probes are done; restart and fleet visibility remain. See **Foundation Sub-Issues** below for F9 rows.
- 🟡 **F10** — Agent org-chart / team primitive. Schema, persistence, and resolution helpers are done; admin editing remains. See **Foundation Sub-Issues** below for F10 rows.
- 🟡 **F11** — Aux-LLM trace-judge framework. Judge dispatch and trace preparation are done; eval and subscriber distribution remain. See **Foundation Sub-Issues** below for F11 rows.
- ⬜ **F12** [#685](https://github.com/HybridAIOne/hybridclaw/issues/685) — **Change Manifest (AHE-style falsifiable contracts).** Typed metadata on every editable-surface change (system prompt · skill · tool · middleware · sub-agent · config · long-term memory) recording: failure evidence (task IDs + patterns), inferred root cause, targeted fix, predicted impact (`expected_fixes`, `at_risk_regressions`), evidence pointer. Verified by the next eval run; rollback at file granularity; predicted-vs-observed deltas drive an attribution score (paper [§3.3, Algorithm 1, §4.4.2](https://arxiv.org/html/2604.25850v1): 33.7%/51.4% precision/recall on fixes, ~5× random; regression precision/recall 11.8%/11.1% — known blindness, design for it). Composes with F4 versioning + F2 event bus + F11 trace-judge + R3 scoreboard. Substrate for **R10a auto-harness-evolution**. Anchored in [Lin et al., AHE, 2026-04-28](https://arxiv.org/html/2604.25850v1).
- ✅ **F13** [#698](https://github.com/HybridAIOne/hybridclaw/issues/698) — **Non-LLM credential injection rail** (closed 2026-05-01 via [PR #728](https://github.com/HybridAIOne/hybridclaw/pull/728)). Extends the existing `SecretRef` system ([`src/security/secret-refs.ts`](../../../src/security/secret-refs.ts), [`runtime-secrets.ts`](../../../src/security/runtime-secrets.ts)) — *not a new vault, the store already exists*. F13 adds: (a) a keystroke-layer injection API that resolves a `SecretRef` and types into a Playwright element handle (or equivalent) **without ever returning the cleartext as a string in agent-tool-result scope** — opaque handle in, keystrokes out; (b) per-skill / per-host / per-selector ACL via **F3** (skill `invoice-harvester` may resolve `cred:datev/*` only when typing into `*.datev.de`); (c) audit events on every resolve (skill, selector, host) feeding the hash-chain log; (d) type discipline / lints to prevent accidental string-coercion (`String(ref)`, template interpolation, JSON-stringify) inside skill code. **Orthogonal to R4**: R4 owns text-flow placeholders (NDA / client / price strings traversing prompts); F13 owns DOM-flow injection (credentials never traverse the prompt at all). Composes with **F3** (policy) + **F12** (manifest records cred-binding edits) + **R6** (post-hoc leak scan as defense-in-depth). Required by **R30** (browser channel) + **R21.7–R21.10** (Hetzner / SAP / DATEV / Lexware) + **R21.11–R21.16** (DACH compliance bundle). *Principle VII.* Added 2026-04-30.
- ✅ **F14** [#699](https://github.com/HybridAIOne/hybridclaw/issues/699) — **Interactive escalation / 2FA handover primitive** (closed 2026-05-01 via [PR #729](https://github.com/HybridAIOne/hybridclaw/pull/729)). Durable pause-and-resume for any agent step that needs a human in the loop — canonical case is 2FA challenges (TOTP code, push approval, QR scan, SMS code). **Reuses existing approval-prompt wire format** at [`src/gateway/pending-approvals.ts:18-30`](../../../src/gateway/pending-approvals.ts) (`PendingApprovalPrompt` + `APPROVAL_PROMPT_DEFAULT_TTL_MS`) — but the current 120s in-memory TTL is unfit for 2FA handover; F14 needs **F4-backed durable park** with extended TTL. F8 escalation routing already emits `escalationRoute` + `escalationTarget`. The runtime: *(i)* detects the challenge (skill-declared waypoint or selector heuristic + LLM "I'm stuck on a 2FA page" signal), *(ii)* parks the session (Playwright frame state + screenshot + URL persisted via F4), *(iii)* emits `escalation.interaction_needed` on the F2 event bus with context + modality hint (`totp` · `push` · `qr` · `sms` · `recovery_code`), *(iv)* routes to the operator via **F8** + **F10** — push notification, SMS (R24), WhatsApp ([R36 #734](https://github.com/HybridAIOne/hybridclaw/issues/734)), Discord ([R37 #735](https://github.com/HybridAIOne/hybridclaw/issues/735)), email, mobile admin (R12), Telegram, *(v)* accepts the operator response via a typed return channel (`{kind: 'code', value: '123456'}` · `{kind: 'approved'}` · `{kind: 'scanned'}`), *(vi)* resumes the session — TOTP/SMS codes go in via **F13** so cleartext never reaches the LLM. **Design rule: never auto-fill 2FA, even when the second factor is technically resolvable as a `SecretRef`.** Reasons: (a) Principle VII audit story is cleaner with operator-in-loop; (b) push / QR / hardware-key can't be auto-filled anyway; (c) auto-filling TOTP defeats the spirit of 2FA. Generalizes beyond browser — any tool needing human-in-loop mid-execution (sensitive write to CRM, contract send, wire transfer) uses the same pause-and-resume primitive. Composes with **F8** + **F10** + **R12** mobile admin + **R24** SMS + **R29** board (paused sessions surface as `blocked: needs 2FA` cards). Required by **R30** (every enterprise SaaS login is 2FA-gated) + every R21.x skill that fronts a SaaS portal. *Principles II + V + VII.* Added 2026-04-30.
- ⬜ **F15 — Plugin-loadable channel registry.** Today [`src/channels/channel-registry.ts`](../../../src/channels/channel-registry.ts) is a hardcoded `Record<ChannelKind, ChannelInfo['capabilities']>` over the in-repo channels (`discord`, `email`, `imessage`, `msteams`, `signal`, `slack`, `telegram`, `voice`, `whatsapp`, plus internal `tui` / `heartbeat` / `scheduler`). F15 makes the registry plugin-loadable so a plugin under [`src/plugins/`](../../../src/plugins/) can register a 9th channel without touching core — declares setup wizard, send / receive hooks, slash-command surface, webhook delivery, prompt adapter. Bundled platforms ship as plugins themselves so the seam is exercised. **Pre-req for R39** (Matrix) and any future channel additions; without it, every new channel is a `src/channels/` rewrite. Composes with the existing `PluginManager` + [`src/plugins/plugin-install.ts`](../../../src/plugins/plugin-install.ts) infra. *Principle V.* Added 2026-05-02.
- ⬜ **F16 — Plugin install from URL + signed manifest verification.** Extends the existing [`src/plugins/plugin-install.ts`](../../../src/plugins/plugin-install.ts) infrastructure (already does dependency planning + binary checks) with: (a) install from a direct HTTP(S) URL pointing at a `hybridclaw.plugin.yaml`, (b) signed-manifest verification (publisher key, content hash, version pin), (c) sig-mismatch refuses install. Required for the **F15** plugin model to flex outside the bundled set — without URL install, plugins can only ship via the vendored repo. Composes with **F4** versioning + **R23** backup (rollback on bad install) + **F15** registry (plugin-shipped channels install through this rail). *Principle VII.* Added 2026-05-02.
- ⬜ **F17** [#785](https://github.com/HybridAIOne/hybridclaw/issues/785) — **Generalized `managed_by_*` policy convention.** Reusable primitive that lets connector-setup commands (HTTP secret route, MCP add, skill install, channel register, provider connect) auto-write a narrowly-scoped F3 policy rule under a managed namespace and clean it up on disconnect. Pioneered ad-hoc by [PR #784](https://github.com/HybridAIOne/hybridclaw/pull/784) for HTTP secret routes (`src/policy/secret-route-policy.ts` writes a `secret_resolve_allowed` rule scoped to host + header + secret + agent, marked `managed_by_secret_route: true`); F17 extracts the read-modify-write helper into a shared module so every connector type follows the same convention without re-implementing rule placement, idempotency, removal, and audit emission. **Trust boundary held**: managed rules stay narrow (no wildcards), deny-by-default still applies, user-authored rules are never overwritten. **Audit primitive**: every managed-rule mutation emits `policy.managed_rule_added` / `policy.managed_rule_removed` so operators can see which connector wrote which grant. **Required by R45** consumer wiring (#786 MCP, #787 skill, #788 channel) and by **R42**'s inline credential paste flow. Composes with **F3** policy engine + **F13** credential rail + **R23** backup (managed rules round-trip through restore). *Principles VII + X.* Added 2026-05-02.

## Foundation Sub-Issues

Use these as issue titles. Keep each issue small enough to ship independently.

| ID | Area | Todo | Status |
|----|------|------|--------|
| F6.1 | Public URL | Deployment-mode config schema | ✅ Done |
| F6.2 | Public URL | `TunnelProvider` interface and ngrok reference implementation | ✅ Done |
| F6.3 | Public URL | Tunnel health check and auto-reconnect with capped-backoff jitter | ✅ Done |
| F6.4 | Public URL | Read-only admin surface for public URL and tunnel status | ✅ Done |
| F6.5 | Public URL | Deployment-mode and public-URL docs | ✅ #570 |
| F6.6 | Public URL | Tailscale Funnel provider | ✅ #644 |
| F6.7 | Public URL | Cloudflare Tunnel provider | ✅ #645 via PR #794 |
| F6.8 | Public URL | Admin UI for tunnel provider configuration | ⬜ #681 |
| F7.1 | Identity | Canonical user IDs | ✅ #571 via PR #776 |
| F7.2 | Identity | Instance-ID allocation | ✅ #572 |
| F7.3 | Identity | Cross-instance identity resolver | ⬜ #573 |
| F7.4 | Identity | TOFU trust ledger for peer instances | ⬜ #574 |
| F8.1 | Policy | Autonomy levels | ✅ Done |
| F8.2 | Policy | Stakes classifier | ✅ Done |
| F8.3 | Policy | Escalation routing | ✅ Done |
| F8.4 | Policy | Runtime default-action config knob | 🟡 Substantially shipped via #608 and #641 |
| F8.5 | Audit | Dedicated autonomy/escalation audit-event type | ⬜ To be filed |
| F8.6 | Policy | Hook-fed approval rule pipeline | ⬜ #731 |
| F8.6.1 | Policy | Hardline blocklist pre-step for unrecoverable commands | ⬜ To be filed |
| F8.7 | Policy | Signed remote policy authority over R1 federation | ⬜ #732 |
| F8.8 | Policy | Behavioral anomaly reranker over tool-call sequences | ⬜ #733 |
| F8.9 | Policy | External approval-loop hooks for tenant-side risk signals | ⬜ To be filed |
| F9.1 | Runtime | Warm process pool and cold-start budget | ✅ #590 |
| F9.2 | Runtime | Per-coworker liveness probe | ✅ #591 via PR #694 |
| F9.3 | Runtime | Auto-restart with backoff | ⬜ #592 |
| F9.4 | Runtime | Fleet red/green dashboard | ⬜ #593 |
| F10.1 | Org chart | Team schema and tree validation | ✅ Done |
| F10.2 | Org chart | Persisted team structures via F4 | ✅ #595 |
| F10.3 | Org chart | Resolution helpers for managers, peers, and escalation chains | ✅ #596 |
| F10.4 | Org chart | Admin UI to view and edit org chart | ⬜ #597 |
| F11.1 | Judge | Judge interface and cheap-model dispatch | ✅ Done |
| F11.2 | Judge | Windowed and redacted trace preparation | ✅ #621 |
| F11.3 | Judge | Eval-the-judge suite | ⬜ #622 |
| F11.4 | Judge | Subscriber pattern with progressive trace-debugger artifacts | ⬜ #623 |

## Cross-Cutting Work

Engineering hygiene that ships alongside P0:

- ⬜ **A1** — End-to-end smoke scenario exercising #1 + #2 + #3 + #4 + #5 + #6 in one run.
- ✅ **A2** — `CHANGELOG.md` with manifesto-principle tags per entry.
- ✅ **A3** — Test-fixtures library (agents, clients, threads, secrets).
- ⬜ **A4** — CI cost-regression gate against the eval suite.
- ⬜ **A5** — Threat-model document for any feature touching secrets or keys.
- ⬜ **A6** [#701](https://github.com/HybridAIOne/hybridclaw/issues/701) — Browser-agent eval suite via [browser-use/benchmark](https://github.com/browser-use/benchmark): **BU Bench V1** (100 tasks aggregating WebBench + Mind2Web 2 + GAIA + BrowseComp + custom, encrypted to prevent training contamination) for skill scoring across Opus / Sonnet / Haiku, and **Stealth Bench V1** (71 tasks across hosted-browser providers — `browserbase`, `browserless`, `hyperbrowser`, `anchor`, `onkernel`, `steel`, `local_headful`, `local_headless`) as a vendor-selection scorecard for the **R30** cloud install mode. Two run modes: *(i) substrate eval* — score browser-use as-is against our chosen install mode and model, gating R30 install-mode promotion in CI; *(ii) harness adapter* — wrap the HybridClaw agent loop to consume the same encrypted task JSON, feeding **R10.1** trajectory collection so **R10a** harness evolution targets browser skills (the Web-Bench analogue to AHE's Terminal-Bench, [paper §4.1](https://arxiv.org/html/2604.25850v1)). Feeds **F5** capability matrix with browser-skill scores per model. *Caveat:* the benchmark repo currently has no `LICENSE` file (constituent task sources are MIT except GAIA which is encrypted-only) — pin as submodule rather than vendor pending clarification with browser-use. Added 2026-04-30.

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


## Skill Boundaries

To keep roadmap execution aligned with **Principle I** and avoid accidental core bloat, apply this guardrail to every roadmap issue and PR:

- **Placement preference (hard order):** **Skill > Plugin > Gateway/Agent `src`**. Start in `skills/<name>/`; if reuse across skills/channels/operators is needed, promote to a plugin; touch gateway/container core only for unavoidable platform seams.
- **Gateway change admission test:** a core change is allowed only if at least one is true: (a) security boundary (F3/F8/F13/F14), (b) cross-skill/plugin primitive reused by 3+ surfaces, (c) transport/runtime substrate impossible to host in a skill or plugin.
- **Plugin promotion trigger:** when logic is tenant-portable and reused by multiple skills/channels, package it as a plugin (`src/plugins/` + install rail), not duplicated helpers across skills.
- **Plugin-first channel rule:** new channels ship as plugins once F15/F16 land; avoid direct `src/channels/*` expansion except for foundational substrate fixes.
- **Issue template addition (R21.x, R30, channel work):** add a required "Why not a skill-only change?" section plus a "core LOC budget" estimate to force explicit tradeoffs before implementation.
- **Review metric:** track per-issue `skill LOC : core LOC` ratio; target **>= 4:1** for feature work (exceptions documented for foundation issues like F2/F4/F7/F8).
- **Done criteria update:** every feature PR must show (1) skill entrypoint path, (2) core seam touched, (3) rationale for each non-skill file changed.

## Skill/Plugin Review

Review existing roadmap items with the new preference order (**Skill > Plugin > Gateway/Agent `src`**):

- **#18 Voice / outbound phone channel:** keep Twilio runtime substrate thin in core; implement call-flow orchestration + operator UX as a channel plugin and expose task-specific behaviors via skills.
- **#19 Calendar / meeting presence:** treat each meeting provider connector (Zoom/Meet) as plugin surfaces; keep summarization/action-item behavior in skills.
- **#24 SMS channel:** implement provider adapters as plugins (Twilio/Telekom/Vodafone), keeping only shared channel contracts in core.
- **#26 Fax gateway + outbound skill:** gateway stays transport seam; provider integrations should be plugin packages, while fax workflows remain in skills.
- **R36 / R37 / R39 channel expansions:** execute through F15/F16 plugin registry + signed install path, not direct core channel additions.
- **R21.x SaaS adapters (especially R21.17–R21.20, R21.12–R21.16):** default to skill-owned adapters; extract shared auth/session/tooling to plugins only when reused by multiple skills.

Operationally: any issue in the list above should add a "Skill-only? Plugin? Core?" decision note before implementation begins.

## Sequencing rules

- **Foundations first.** F1, F2, F3 unblock the majority of P0 children. F4 and F5 unblock specific items. F6 and F7 are critical-path the moment any cross-instance work or local-install demo is involved. F8, F9, F10 are needed as soon as the launch demo (A1) tries to honour Principles II / III / VI.
- **Skills early.** #21.1 (skill packaging framework) should land before any of #21.2-#21.6 (the five production skills). Without the framework each skill reinvents lifecycle + permissioning.
- **Skill body MUST live under `skills/<name>/` with colocated helpers.** No reach-back into `src/`. Skills are synced into `/workspace/skills/<name>` at agent runtime — `src/` paths are not accessible there ([`skills/hybridclaw-help/SKILL.md:98`](../../../skills/hybridclaw-help/SKILL.md) is the canonical statement). Reference precedent: [`skills/office/`](../../../skills/office/) (SKILL.md + `.cjs` helpers + `helpers/`). Anti-pattern caught and corrected during PR [#772](https://github.com/HybridAIOne/hybridclaw/pull/772) review (initial implementation put ~2,000 lines in `src/invoices/` with a thin pointer-only SKILL.md). Every R21.x issue body should pin this placement explicitly — at-risk issues to update: R21.17 [#722](https://github.com/HybridAIOne/hybridclaw/issues/722), R21.18 [#723](https://github.com/HybridAIOne/hybridclaw/issues/723), R21.19 [#724](https://github.com/HybridAIOne/hybridclaw/issues/724), R21.20 [#759](https://github.com/HybridAIOne/hybridclaw/issues/759), R21.12–R21.16 [#689–#693](https://github.com/HybridAIOne/hybridclaw/issues/689), and R32/R33 server-maintenance bundle.
- **A2A before workflow.** #1 must ship at least to 1.2 (send/receive runtime API) before #2.2 (sequential runner) becomes useful.
- **F7 before A2A federation + R9.** R1.6–R1.9 (#717–#720, A2A federation) and R9.1–R9.6 (#480–#484, #486, RPC delegation) both depend on F7.1–F7.4 (#571–#574) shipping first — canonical IDs, instance-id allocation, resolver, and TOFU trust are the substrate both tracks consume. Gate F7 children at P0 to keep both cross-instance tracks unblocked.
- **Two cross-instance tracks, one shared infra.** R9 (delegation, RPC) and R1.6–R1.9 (federation, messaging) are different features but share transport (#482), auth (#480 + #574), and audit (#483). Sequence the shared infra before either feature track tries to integrate.
- **R1.10 transport registry before any encoder.** R1.11–R1.15 ([#766](https://github.com/HybridAIOne/hybridclaw/issues/766), [#767](https://github.com/HybridAIOne/hybridclaw/issues/767), [#768](https://github.com/HybridAIOne/hybridclaw/issues/768), [#769](https://github.com/HybridAIOne/hybridclaw/issues/769), [#771](https://github.com/HybridAIOne/hybridclaw/issues/771)) all register against the R1.10 ([#765](https://github.com/HybridAIOne/hybridclaw/issues/765)) transport-adapter interface + peer-descriptor schema. Building any encoder against an ad-hoc shape means refactoring it the moment the second encoder lands. Land R1.10 as a tiny first PR (interface + default `internal` adapter wired into R1.6 routing), then A2A and webhook adapters become parallel tracks. R1.15 SSE streaming is a follow-up to R1.11 + R1.12 — don't pre-plan the SSE wiring inside the first A2A PRs.
- **Webhook outbound (R1.13) before A2A outbound (R1.11) for early integrations.** Webhook is dramatically simpler (POST + HMAC, no Agent Card discovery, no JSON-RPC server). Shipping R1.13 first unlocks Zapier / n8n / monitoring integrations on day one and exercises the R1.10 registry shape with a simple encoder before A2A's heavier surface lands. A2A outbound stays P0 (it's the rich path) but is not the path of first integration.
- **F8 alongside #2.** #2.3 (gating semantics) should not land before F8.4 (default-action runtime) — otherwise #2 hard-codes approval-by-default and has to be refactored.
- **Trajectory capture starts early.** 10.1 (trajectory collection) should land alongside F2, well before the rest of #10 — the data is the asset.
- **Leak classifier needs a dataset.** 6.1 (classifier dataset) gates 6.2 / 6.3; budget for labeling time.
- **Avoid net-new channels until P0 ships.** New channel work (#18, #19) is deferred to P2 even where infrastructure exists.
- **F12 before R10a.** The Change Manifest (F12) is a hard prereq for the harness-evolution loop (R10.8) — without falsifiable per-edit contracts the loop drifts and there is no rollback signal. Land F12 alongside F11.4 so the manifest can reference distilled evidence by file path.
- **R29 board reads F2, not the DB.** The kanban surface must subscribe to the skill-run event bus (F2) for live state, not poll. Otherwise the "running 4/6" footer lies under load.
- **R30 before R21.11.x / R21.15 / R21.16.** The scrape-path adapters in the DACH compliance skills (R21.11.x #778 invoice scrape adapters, Handelsregister, Schufa) cannot exit quarantine without the R30 browser substrate + F13 credential injection + F14 2FA handover. The **API-adapter half of R21.11 has shipped without R30** (PR #772, 2026-05-02 — Stripe/AWS/Azure/Google Ads are pure REST). Don't start the *scrape* skill bodies for these issues until R30(a) local install mode has landed.
- **F13 + F14 before R30.** ✅ Both prereqs now done (F13 #698 via PR #728, F14 #699 via PR #729 — 2026-05-01). R30 (#700) is unblocked and is the next critical-path foundation for the DACH compliance bundle (R21.11 invoice harvester, R21.15 Handelsregister, R21.16 Schufa). **R30 children R30.1–R30.10 should be filed as separate issues to enable parallel execution** — see *Next parallel work* below.
- **R31 before any new multi-agent skill design.** Before filing a new skill that decomposes work across multiple agents, the author must pick the R31 architecture (sub-agent vs agent-team) and justify the split against the *"split by context, not by role"* rule. Catches role-named pipelines (`Planner → Implementer → Tester`) before they ship and lose information at every handoff. R29 board provides the shared-task-list substrate for the agent-team path.
- **R32 before R33.** The local-execution maintenance skill (R32) defines the shell / systemd / log capability surface; R33 reuses that surface over SSH transport. Building R33 first means inventing a transport-coupled API that R32 then has to retrofit — wrong direction. Build R32 against a transport-agnostic skill interface, then R33 plugs SSH in.
- **F13 before R33.** R33's SSH-key handling depends on F13's keystroke-/stream-injection rail — without it, SSH private keys end up as strings in the LLM context the first time a host is touched. Acceptable to demo R32 alone before F13 lands (no remote credentials), but R33 should not start.
- **R9 + F5 before R34.** R34 is a thin policy + advertisement layer on top of R9 cross-instance delegation and F5 capability matrix. Don't build the routing logic until both substrates are stable.
- **F8.6 before F8.7 + F8.8.** Both extensions plug into the rule-pipeline shape that F8.6 introduces. Building them on the current monolithic `evaluateToolCall` ([`container/src/approval-policy.ts:1286-1498`](../../../container/src/approval-policy.ts)) means refactoring twice — once into a one-off branch, then again when F8.6 lands. Land F8.6 first, then F8.7 (remote policy) and F8.8 (anomaly reranker) become rule additions instead of function rewrites.
- **F7 + R1 federation before F8.7.** Signed remote policy updates need canonical agent / instance IDs (F7.1–F7.4 #571–#574) to verify the authority and the R1.6–R1.9 federation transport (#717–#720) to receive them. Building F8.7 before either substrate means inventing a one-off transport + auth shape that gets thrown away.
- **R10.1 trajectories before F8.8.** The Markov / frequency baseline trains on prior approved tool-call sequences. Without R10.1 trajectory storage there is nothing to fit. F8.8 cold-starts (abstain until N≥50 approved trajectories per agent) so it's safe to ship F8.8 against a still-warming trajectory store, but R10.1 must be live first.
- **R36 / R37 land independently.** Channel rows have no ordering constraint vs. F8.x or each other; they're additive registrations on F14's modality list. Either can ship alone if the other slips.
- **R35 needs F8 + F11.4 + R5 before production.** Council mode without the F8 stakes gate runs N× cost on every turn — disable until F8.4 default-action wiring is solid. R35.3 (council-as-judge) cannot land before F11.4 subscriber pattern. Per-tenant council-fired-per-day rate caps must consume R5 metering before any tenant outside dogfooding gets council enabled. **R35 ≠ R28**: R28 is failover (sequential), R35 is deliberation (parallel) — they share provider config but not the runtime path; do not collapse them.
- **F15 before R39 / any new channel.** F15 unhardcodes [`src/channels/channel-registry.ts`](../../../src/channels/channel-registry.ts). Adding **R39** Matrix (or any future channel) without F15 forces a core edit instead of a plugin install. R36 (WhatsApp), R37 (Discord), and **R38** (MS Teams ✅) all live as in-repo channels under the *current* hardcoded registry — F15 is for *new* channels, not a re-platforming of existing ones.
- **F2 vocabulary additions before F8.9.** F8.9 approval hooks are useless without (a) **F11.4** subscriber pattern to receive results and (b) the two missing hook names (`before_approval_request`, `after_approval_response`) registered in `PluginHookName`. Land the F2 vocabulary additions first, then F8.9 wires the cascade.
- **F8.6 step 0 hardline blocklist before F8.6 cascade refactor.** The blocklist is config-file-driven and orthogonal to the predicate pipeline; ship it as a pre-step so the cascade refactor doesn't have to also invent the blocklist semantics in the same PR. Step 0 also gives F8.7 (remote policy authority) something it explicitly cannot override — the trust boundary is clearer when the floor exists before delegation does.
- **R30.2 before R43.** R43 computer-use track reuses the same provider-interface shape as R30 (`launchPersistentContext`-style lifetime, F13 keystroke hook, navigation guard pattern). Building R43 first means inventing a provider abstraction R30 has to retrofit. Sequence R30.2 → R30.6 (F13 wiring) → R43 to avoid the rewrite.
- **Redaction defaults are non-negotiable per Principle VII.** *"The model never sees a real secret"* is not a tunable. Any PR that proposes flipping confidential-redaction off-by-default is rejected at review; tenant overrides require an explicit per-tenant flag *and* an audit-event entry on every override-active turn. Applies to **R4** confidential-rules, **F13** credential injection, **R6** leak classifier, and any future masking surface. Prevents drift from imported defaults.
- **F17 before R45 children + R42.** F17 extracts the shared `managed_by_*` helper. The R45 children ([#786](https://github.com/HybridAIOne/hybridclaw/issues/786) MCP, [#787](https://github.com/HybridAIOne/hybridclaw/issues/787) skill install, [#788](https://github.com/HybridAIOne/hybridclaw/issues/788) channel registration) and **R42**'s inline credential paste should consume that helper, not re-implement read-modify-write logic per connector — otherwise four divergent rule-placement code paths land in parallel. Acceptable to ship F17 alongside the first child rather than strictly before, but the first child PR must include the [`src/policy/secret-route-policy.ts`](../../../src/policy/secret-route-policy.ts) retrofit so PR #784's call site converges with the new helper at the same time.

## Out of scope

- Net-new chat channels are P1+ work and only after **F15** unhardcodes the channel registry — they ship as plugins, not core edits to `src/channels/`.
- Generic "more skills" beyond the production-grade five in #21 — additional skills are folded into the same pipeline, not added as feature-count items.
- Anything that requires the end user to open the desktop app (Principle V).
- Per-coworker "away" / clock-out semantics — explicitly anti-Principle III.
