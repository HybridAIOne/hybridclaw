---
title: ISO/IEC 42001 AIMS Readiness
description: Working ISO/IEC 42001:2023 AI management system readiness matrix for HybridClaw.
sidebar_position: 10
---

# ISO/IEC 42001 AIMS Readiness

This is a working compliance support artifact, not a certification claim. It
maps repo-visible HybridClaw evidence to an ISO/IEC 42001:2023 artificial
intelligence management system (AIMS) preparation plan.

Control intent is paraphrased. Use the purchased ISO standard for normative
requirements and control wording.

## Standard Reference

- Reviewed against the ISO-published
  [ISO/IEC 42001:2023](https://www.iso.org/standard/42001) page on 2026-06-16.
- ISO lists ISO/IEC 42001:2023 as published, Edition 1, publication date
  2023-12.
- ISO describes ISO/IEC 42001 as a management-system standard for establishing,
  implementing, maintaining, and improving an AIMS for organizations that
  provide or use AI-based products or services.

## Scope And Assumptions

- Review date: 2026-06-16.
- Scope: this repository, bundled docs, provider routing, model selection,
  agent orchestration, tool approvals, sandbox execution, memory, skills,
  output guards, audit logs, and developer workflows.
- Out of scope: company AIMS records, HR records, legal opinions, customer
  contracts, customer-specific data protection impact assessments, production
  telemetry, vendor contracts, and board-level management review records unless
  represented in this repo.
- Status values:
  - `Evidence`: repo contains concrete implementation or documentation.
  - `Partial`: repo contains useful evidence, but operating evidence or
    management-system coverage is incomplete.
  - `Gap`: no sufficient repo-visible evidence.
  - `Operator evidence`: primarily proven outside the product repo.
- This document should be used together with the
  [ISO/IEC 27001 control matrix](./iso27001-control-matrix.md). The security
  management system should carry shared controls such as access control,
  supplier governance, logging, incident response, and secure development.

## Product AI System Scope

For AIMS scoping, treat HybridClaw as an AI assistant orchestration product with
these AI-relevant subsystems:

| Subsystem | AI role | Primary risks | Current repo evidence |
| --- | --- | --- | --- |
| Agent conversation loop | Turns user requests, context, memory, and tool results into model prompts and actions. | Prompt injection, misleading outputs, unsafe task decomposition, over-broad authority. | [`src/agent/`](../../../src/agent), [`docs/content/developer-guide/approvals.md`](./approvals.md), [`SECURITY.md`](../../../SECURITY.md) |
| Model/provider routing | Selects model providers and routes requests across HybridAI, OpenAI-compatible APIs, local models, and other providers. | Wrong provider, data sent to unapproved model, untracked model behavior change. | [`src/providers/`](../../../src/providers), [`src/model-selection.ts`](../../../src/model-selection.ts), [`docs/content/reference/model-selection.md`](../reference/model-selection.md) |
| Tool and skill execution | Lets AI-assisted sessions call tools, skills, MCP servers, shell commands, browsers, and external APIs. | Excessive agency, untrusted tool output, data exfiltration, destructive operations. | [`container/src/tools.ts`](../../../container/src/tools.ts), [`container/src/approval-policy.ts`](../../../container/src/approval-policy.ts), [`src/skills/`](../../../src/skills) |
| Container sandbox | Executes agent tools in Docker or host mode with policy gates and mount controls. | Sandbox escape, over-broad mounts, network misuse, resource abuse. | [`src/infra/`](../../../src/infra), [`src/security/mount-security.ts`](../../../src/security/mount-security.ts), [`docs/content/developer-guide/runtime.md`](./runtime.md) |
| Memory and transcripts | Persists conversation context, summaries, memory, and trace exports. | Privacy leakage, stale or wrong memory, cross-session contamination, retention gaps. | [`src/memory/`](../../../src/memory), [`docs/content/developer-guide/memory.md`](./memory.md), [`docs/content/developer-guide/session-routing.md`](./session-routing.md) |
| Audit and output guard | Records approvals, audit events, leak scans, output-guard classifier decisions, and session traces. | Incomplete evidence, unmonitored incidents, unexplainable decisions, retained sensitive data. | [`src/audit/`](../../../src/audit), [`src/gateway/output-guard-admin.ts`](../../../src/gateway/output-guard-admin.ts), [`docs/content/developer-guide/runtime.md`](./runtime.md) |

## Immediate AIMS Gap Register

| ID | Priority | AIMS area | Gap | Repo evidence | Next evidence or control |
| --- | --- | --- | --- | --- | --- |
| AIMS-001 | P0 | AIMS scope, context, and interested parties | No visible AIMS scope statement, interested-party register, or AI-specific applicability rationale. | This readiness document defines a starter product scope. The ISO/IEC 27001 matrix already defines security-scope assumptions. | Create an AIMS scope record with product boundaries, deployment modes, affected stakeholders, regulatory/customer obligations, exclusions, and owner approval. |
| AIMS-002 | P0 | AI policy and objectives | No approved AI policy, measurable AI objectives, or management review cadence is visible. | Security posture is documented in [`SECURITY.md`](../../../SECURITY.md) and [`TRUST_MODEL.md`](../../../TRUST_MODEL.md). | Add an AI policy covering responsible use, human oversight, data handling, transparency, safety/security, evaluation, incident handling, and continual improvement. |
| AIMS-003 | P0 | AI system inventory | There is no central AI system inventory for HybridClaw subsystems, providers, model classes, tools, data stores, and user-impacting decisions. | Provider and subsystem code is visible across `src/`, `container/src/`, and docs. | Maintain the inventory template in [ISO/IEC 42001 Evidence Templates](./iso42001-aims-evidence-templates.md) with owner, purpose, data categories, model/provider, risk tier, and evidence links. |
| AIMS-004 | P0 | AI risk management | AI-specific risks are spread across security docs and tests, but no AIMS risk register links risks to treatments, residual risk, owners, and review status. | Prompt and secret risks are documented in [`docs/content/developer-guide/threat-model.md`](./threat-model.md), [`SECURITY.md`](../../../SECURITY.md), and approval docs. | Create an AI risk register covering prompt injection, excessive agency, model/provider drift, memory leakage, unsafe tool use, hallucinated facts, privacy leakage, and unbounded consumption. |
| AIMS-005 | P0 | AI impact assessment | No repeatable impact assessment exists for new AI features, providers, skills, or high-impact deployment contexts. | PR template requires risk notes and validation, but not AI impact fields. | Add an AI impact assessment template for new model routes, autonomous tools, memory changes, output guards, and customer-impacting workflows. |
| AIMS-006 | P1 | Data governance for AI | Data categories are documented in security terms, but not as an AI data lifecycle covering source, purpose, retention, quality, provenance, consent, and deletion. | Memory and session docs describe storage boundaries. Confidential filtering is documented in [`SECURITY.md`](../../../SECURITY.md). | Add an AI data register for prompts, tool results, transcripts, memory, embeddings, provider payloads, eval fixtures, logs, and generated artifacts. |
| AIMS-007 | P1 | Model and supplier governance | Provider integrations exist, but there is no model/provider approval register, review cadence, DPA/security review status, or model-change monitoring evidence. | Provider code and model selection docs exist. | Add a provider and model review record with data processing, hosting location, retention, safety features, rate limits, fallback behavior, and deprecation plan. |
| AIMS-008 | P1 | Human oversight and authority boundaries | Runtime approvals exist, but there is no AIMS-level statement of which decisions require human approval, interruption, escalation, or denial. | Approval policy and traffic-light tiers are documented in [`docs/content/developer-guide/approvals.md`](./approvals.md). | Map AI action categories to required human oversight, escalation owner, approval evidence, and denied-action logging. |
| AIMS-009 | P1 | AI evaluation and acceptance criteria | Tests exist, but there is no AI behavior acceptance framework for model/provider changes, prompt changes, tool autonomy, output guards, and memory behavior. | Vitest suites cover many runtime boundaries; trace and eval modules exist in [`src/distill/`](../../../src/distill) and [`src/session/session-trace-export.ts`](../../../src/session/session-trace-export.ts). | Define eval suites, adversarial prompts, regression thresholds, release gates, and sign-off records for AI behavior changes. |
| AIMS-010 | P1 | AI monitoring and incident management | Audit logs exist, but AI-specific incident categories, monitoring thresholds, escalation paths, and post-incident reviews are not documented. | Hash-chained audit and leak scanning are documented in [`SECURITY.md`](../../../SECURITY.md). | Add AI incident categories for unsafe action, data leak, provider outage, model regression, policy bypass, memory contamination, and high-cost runaway behavior. |
| AIMS-011 | P2 | Transparency and user communication | Product trust docs exist, but no standard disclosure template explains AI limitations, model/provider routing, data persistence, and human approval boundaries for customers. | [`TRUST_MODEL.md`](../../../TRUST_MODEL.md) provides operator acceptance language. | Add customer-facing AI transparency text and support-response language for hosted or enterprise deployments. |
| AIMS-012 | P2 | Continual improvement | No recurring AIMS improvement cycle, metrics review, or corrective-action register is visible. | CI, tests, and docs provide engineering evidence but not management-system evidence. | Add quarterly AIMS review records with risk changes, incident trends, eval results, supplier changes, customer feedback, and improvement actions. |

## Coverage Matrix

| AIMS area | Status | Repo-visible evidence | Main gap to close |
| --- | --- | --- | --- |
| Context, scope, interested parties | Partial | Product architecture and runtime docs describe the system boundaries. | Formal AIMS scope, stakeholder map, obligations register, exclusions, and management approval. |
| Leadership, policy, roles, objectives | Gap | Security ownership is implied by docs and PR review expectations. | Approved AI policy, named AIMS owner, role/accountability matrix, objectives, and management review. |
| AI risk and impact assessment | Partial | Security threat model and approval policy cover several AI-agent risks. | AI-specific risk register, impact assessment workflow, residual-risk approvals, and review cadence. |
| AI system inventory | Partial | Subsystems and providers are visible in code and docs. | Central register linking subsystem, purpose, data, model/provider, tools, owner, risk tier, and evidence. |
| Data governance | Partial | Memory, session routing, redaction, and runtime secrets are documented. | AI data lifecycle records for prompt payloads, memory, transcripts, embeddings, eval fixtures, and provider data processing. |
| Provider and supplier management | Partial | Provider integrations and model selection logic are implemented. | Supplier/model approval records, DPA/security review, data residency, retention, availability, fallback, and exit plan. |
| Human oversight | Evidence | Green/yellow/red approval tiers, red-tier approvals, and admin approval surfaces exist. | AIMS-level mapping from AI action type to oversight requirement and evidence retention. |
| Operational control | Partial | Container sandbox, mount allowlists, policy hooks, and audit trails exist. | AIMS operating procedure that ties controls to AI risks and production evidence. |
| Evaluation and validation | Partial | Automated tests and trace/eval modules exist. | AI behavior acceptance criteria, eval suites, prompt/model-change gates, and signed release evidence. |
| Monitoring and incident response | Partial | Audit logs, approvals, leak scan, and incident guidance exist. | AI incident taxonomy, monitoring thresholds, alert evidence, post-incident review, and corrective-action tracking. |
| Transparency and communication | Partial | Trust model explains operator responsibilities and stored data. | Customer-facing AI disclosure, limitations, appeal/escalation path, and hosted-service data-use statement. |
| Continual improvement | Gap | Development workflow and CI exist. | Recurring AIMS reviews, metrics, corrective actions, and improvement records. |

## Evidence Package To Build Next

Create these artifacts before treating HybridClaw as ISO/IEC 42001 audit-ready:

1. `AIMS scope statement`: product boundaries, deployment modes, AI subsystems,
   affected stakeholders, exclusions, and owner approval.
2. `AI policy`: responsible development and use, human oversight, data
   governance, provider governance, evaluation, incident handling, and
   improvement commitments.
3. `AI system inventory`: use the template in
   [ISO/IEC 42001 Evidence Templates](./iso42001-aims-evidence-templates.md).
4. `AI risk register`: risks, causes, affected stakeholders, controls,
   treatment, owner, residual risk, review date, and decision.
5. `AI impact assessment`: required for new provider routes, autonomy changes,
   memory changes, output guard changes, and high-impact deployment contexts.
6. `AI provider and model register`: data categories, retention, location,
   security/privacy review, terms review, model behavior notes, fallback, and
   exit plan.
7. `AI evaluation records`: prompt and model regression suites, adversarial
   tests, tool-boundary tests, acceptance thresholds, failures, and approvals.
8. `AI incident and corrective-action log`: event type, severity, root cause,
   containment, customer impact, model/provider involved, and follow-up owner.

## Engineering Work Items

These are the highest-value product changes that would improve the AIMS case:

1. Add a repo-visible AI system inventory and risk register seeded from the
   tables in this document.
2. Add AI impact assessment fields to the PR template for provider routing,
   model selection, tool autonomy, memory, output guard, and prompt changes.
3. Define AI behavior eval suites for prompt injection, excessive agency,
   memory leakage, model/provider fallback, and output-guard bypass.
4. Add provider/model review records for each supported provider family and
   make model-route changes link to a review entry.
5. Add an AI incident taxonomy and event catalog that maps audit events to
   incident review records.
