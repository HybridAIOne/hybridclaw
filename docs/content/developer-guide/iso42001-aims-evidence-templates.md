---
title: ISO/IEC 42001 Evidence Templates
description: Starter evidence tables for ISO/IEC 42001:2023 AI management system preparation.
sidebar_position: 11
---

# ISO/IEC 42001 Evidence Templates

Use these starter templates to build HybridClaw's ISO/IEC 42001:2023 artificial
intelligence management system evidence package.

Do not commit customer data, personal data, secrets, production prompts,
provider payloads, or live incident records to the public repo. Keep completed
records in the organization evidence store and link back to repo files only
when the evidence is already safe to publish.

## Evidence Naming

Recommended identifiers:

| Prefix | Record type | Example |
| --- | --- | --- |
| `AIMS-SCOPE` | Scope and applicability records | `AIMS-SCOPE-2026-Q3` |
| `AIMS-SYS` | AI system inventory entries | `AIMS-SYS-HYBRIDCLAW-ORCH` |
| `AIMS-RISK` | AI risk register entries | `AIMS-RISK-PROMPT-INJECTION` |
| `AIMS-IA` | AI impact assessments | `AIMS-IA-MODEL-ROUTING-2026-06` |
| `AIMS-PROV` | AI provider/model reviews | `AIMS-PROV-HYBRIDAI-2026-Q3` |
| `AIMS-EVAL` | Evaluation and release records | `AIMS-EVAL-AGENT-TOOLS-2026-06` |
| `AIMS-INC` | AI incident or deviation records | `AIMS-INC-2026-0001` |
| `AIMS-MR` | Management review records | `AIMS-MR-2026-Q3` |

## AI System Inventory

| Field | Guidance |
| --- | --- |
| System ID | Stable ID, for example `AIMS-SYS-HYBRIDCLAW-ORCH`. |
| System name | Product subsystem or AI-enabled workflow. |
| Owner | Human accountable for risk, lifecycle, and evidence. |
| Purpose | Business and user purpose. |
| Users and affected stakeholders | Operators, admins, end users, customers, maintainers, data subjects, suppliers. |
| Deployment modes | Local, hosted gateway, Discord bot, channel integration, TUI, admin console, container mode, host mode. |
| AI technique | LLM orchestration, model routing, embeddings, classifier, retrieval, tool-calling, output guard, speech or media model. |
| Model/provider | Provider family, local model, hosted model, or user-configured provider. |
| Data categories | Prompts, tool output, transcripts, memory, embeddings, uploaded files, secrets metadata, audit events, generated artifacts. |
| Sensitive data | PII, confidential business data, secrets, credentials, customer data, regulated data. |
| Autonomy level | Advisory only, user-confirmed action, policy-gated action, autonomous scheduled action, admin-only action. |
| Human oversight | Approval tier, escalation path, stop/interrupt path, admin review, or manual validation. |
| Risk tier | Low, medium, high, or prohibited until assessed. |
| Current controls | Prompt rules, approval policy, sandbox, provider config, redaction, audit, evals, docs. |
| Evidence links | Repo files, tickets, eval records, incident records, supplier reviews. |
| Last review | Date, reviewer, decision, next review date. |

### Starter Inventory Entries

| System ID | System name | Purpose | Autonomy level | Risk tier | Current controls | Evidence to add |
| --- | --- | --- | --- | --- | --- | --- |
| `AIMS-SYS-HYBRIDCLAW-ORCH` | Agent conversation loop | Convert user requests, memory, files, and tool results into model calls and assistant actions. | User-directed, policy-gated tool use. | High | Prompt guardrails, tool approvals, audit logs, tests. | Owner, AI risk review, eval suite, release acceptance record. |
| `AIMS-SYS-MODEL-ROUTER` | Model/provider routing | Select and call configured model providers. | User/operator configured. | High | Provider registry, model selection docs, config. | Provider approval register, data processing review, fallback risk review. |
| `AIMS-SYS-TOOL-SANDBOX` | Tool and container execution | Execute shell, browser, MCP, and skill actions for agent sessions. | Policy-gated, sometimes autonomous inside approved task. | High | Docker sandbox, workspace fence, approval tiers, mount validation. | AI action-to-oversight matrix, adversarial tool tests, incident taxonomy. |
| `AIMS-SYS-MEMORY` | Memory and session continuity | Store and recall session context and long-lived memory. | Context injection, not direct action. | High | Session routing, memory docs, confidential filter. | Data lifecycle record, retention/deletion test evidence, memory contamination evals. |
| `AIMS-SYS-OUTPUT-GUARD` | Output guard and safety review | Detect and rewrite or block policy-sensitive output. | Classifier-assisted gate. | Medium | Admin output guard code and tests. | Classifier evaluation record, false positive/negative review, override policy. |

## AI Risk Register

| Field | Guidance |
| --- | --- |
| Risk ID | Stable ID, for example `AIMS-RISK-PROMPT-INJECTION`. |
| Related system IDs | One or more AI system inventory IDs. |
| Risk statement | Event, cause, and impact in one concise sentence. |
| Affected stakeholders | Users, maintainers, customers, suppliers, data subjects, third parties. |
| Threat or failure mode | Prompt injection, hallucination, provider drift, excessive agency, data leak, unsafe tool use, bias, cost runaway. |
| Existing controls | Preventive, detective, and corrective controls. |
| Likelihood | Low, medium, high, or numeric scale used by the organization. |
| Impact | Low, medium, high, or numeric scale used by the organization. |
| Inherent risk | Before treatment. |
| Treatment | Avoid, mitigate, transfer, accept, or prohibit. |
| Treatment owner | Human owner. |
| Due date | Date or recurring review cycle. |
| Residual risk | After controls. |
| Acceptance decision | Approver, date, rationale, evidence link. |
| Monitoring signal | Audit event, metric, eval result, support ticket, alert, incident record. |

### Starter Risk Entries

| Risk ID | Related system IDs | Risk statement | Existing controls | Treatment |
| --- | --- | --- | --- | --- |
| `AIMS-RISK-PROMPT-INJECTION` | `AIMS-SYS-HYBRIDCLAW-ORCH`, `AIMS-SYS-TOOL-SANDBOX` | Untrusted file, web, or tool content instructs the agent to disclose data or take unauthorized actions. | Prompt guardrails, approval tiers, secret threat model, sandbox, audit logs. | Add adversarial evals, high-risk prompt-injection test fixtures, and denied-action evidence. |
| `AIMS-RISK-EXCESSIVE-AGENCY` | `AIMS-SYS-TOOL-SANDBOX` | The agent executes actions beyond the user's intended authority or operational scope. | Red-tier approval, workspace fence, policy hooks. | Maintain an AI action-to-oversight matrix and test unsafe command denial. |
| `AIMS-RISK-MEMORY-LEAKAGE` | `AIMS-SYS-MEMORY` | Stored memory or transcripts expose one user's context to another user or future task. | Session routing, canonical session keys, confidential filter. | Add contamination tests, deletion evidence, and retention schedule. |
| `AIMS-RISK-PROVIDER-DRIFT` | `AIMS-SYS-MODEL-ROUTER` | Provider or model behavior changes without updated risk review or eval sign-off. | Provider abstraction, model metadata tests. | Add provider review records and route-change release gates. |
| `AIMS-RISK-HALLUCINATED-FACTS` | `AIMS-SYS-HYBRIDCLAW-ORCH` | Model output presents unsupported claims as facts in high-stakes contexts. | Stakes classifier, second-opinion commands, user review. | Add citation/evidence requirements and high-stakes response evals. |
| `AIMS-RISK-COST-RUNAWAY` | `AIMS-SYS-HYBRIDCLAW-ORCH`, `AIMS-SYS-MODEL-ROUTER` | Long-running sessions, retries, or loops consume excessive model/tool budget. | Token usage tracking, loop detection, scheduler controls. | Add budget thresholds, alerting, and post-incident review records. |

## AI Impact Assessment

Use an impact assessment before major AI changes, including:

- new model/provider route or fallback behavior
- new autonomous or scheduled tool behavior
- memory, retrieval, transcript, or embedding changes
- output guard or policy classifier changes
- hosted or customer-specific deployment
- workflows affecting legal, financial, employment, safety, health, or other
  high-impact decisions

| Field | Guidance |
| --- | --- |
| Assessment ID | Stable ID, for example `AIMS-IA-MODEL-ROUTING-2026-06`. |
| Change or system | Link to PR, issue, design doc, or inventory entry. |
| Purpose and expected benefit | Why the AI capability is needed. |
| Users and affected parties | Include indirect data subjects where relevant. |
| Data categories | Inputs, generated outputs, logs, memory, embeddings, provider payloads. |
| Sensitivity and legal constraints | PII, confidential data, minors, regulated domains, contractual restrictions. |
| Autonomy and human oversight | What the AI can do and how humans can intervene or approve. |
| Foreseeable misuse | Abuse, prompt injection, over-permissioned actions, social engineering, unsafe advice. |
| Failure modes | Inaccuracy, bias, privacy leak, wrong account, unsafe action, denial of service, cost runaway. |
| Controls | Preventive, detective, corrective controls and tests. |
| Evaluation evidence | Evals, manual review, screenshots, logs, red-team cases, acceptance thresholds. |
| Residual risk | Risk left after controls. |
| Decision | Approve, approve with conditions, defer, reject. |
| Approver and date | Human owner and evidence link. |

## AI Provider And Model Review

| Field | Guidance |
| --- | --- |
| Review ID | Stable ID, for example `AIMS-PROV-HYBRIDAI-2026-Q3`. |
| Provider/model | Provider, API endpoint class, local model family, or user-configured source. |
| Intended use | Supported workflows and prohibited workflows. |
| Data sent | Prompt, tool output, memory, uploaded files, metadata, identifiers. |
| Data retained by provider | Contractual or technical retention position. |
| Hosting and jurisdiction | Region, cloud, local machine, or customer controlled. |
| Security review | Authentication, encryption, access control, logging, abuse controls, incident contact. |
| Privacy/legal review | DPA, subprocessors, data subject rights, restricted data categories. |
| Safety features | Moderation, system prompts, tool limits, content filters, model cards, known limitations. |
| Availability and fallback | SLA, outage behavior, fallback route, user notification. |
| Change monitoring | Model deprecation, version pinning, release notes, regression eval cadence. |
| Exit plan | Disable route, delete data, rotate keys, migrate provider, notify customers. |
| Decision | Approved, conditional, not approved, deprecated. |

## AI Evaluation And Release Record

| Field | Guidance |
| --- | --- |
| Evaluation ID | Stable ID, for example `AIMS-EVAL-AGENT-TOOLS-2026-06`. |
| Change under review | PR, issue, model route, prompt change, policy change, or release. |
| Systems covered | Inventory IDs. |
| Test scope | Unit tests, integration tests, adversarial prompts, manual review, trace replay. |
| Acceptance criteria | Concrete pass/fail thresholds. |
| Results | Command outputs, eval summary, failure list, residual risk. |
| Regressions | Known behavior changes and owner decision. |
| High-risk scenarios | Prompt injection, unsafe tool use, memory leakage, wrong provider, high-stakes claim. |
| Sign-off | Reviewer, date, decision, conditions. |
| Follow-up | Tickets, owners, due dates. |

## AI Incident Or Deviation Record

| Field | Guidance |
| --- | --- |
| Incident ID | Stable ID, for example `AIMS-INC-2026-0001`. |
| Detected by | User report, audit alert, eval, monitoring, support, maintainer. |
| System IDs | Inventory entries involved. |
| Provider/model | Model or provider if relevant. |
| Severity | Organization severity scale. |
| Description | What happened, when, and how it was detected. |
| Affected data or users | Data categories and affected stakeholder groups. |
| Immediate containment | Disable route, revoke token, stop gateway, block tool, patch policy, notify user. |
| Root cause | Technical and process cause. |
| Corrective action | Code, policy, docs, tests, supplier action, communication. |
| Preventive action | Eval, monitoring, training, review cadence, control change. |
| Closure | Owner, date, evidence link, residual risk decision. |

## Management Review Record

| Field | Guidance |
| --- | --- |
| Review ID | Stable ID, for example `AIMS-MR-2026-Q3`. |
| Period | Quarter or date range. |
| Attendees | AIMS owner, security owner, product owner, operations, legal/privacy if relevant. |
| Inputs reviewed | Risk register, incidents, eval results, provider changes, customer feedback, audits, regulatory changes. |
| Metrics | Eval pass rate, policy denials, AI incidents, provider outages, leak-scan findings, cost anomalies. |
| Decisions | Risk acceptances, priorities, provider decisions, policy changes, resources. |
| Actions | Action, owner, due date, tracking link. |
| Next review | Date and required inputs. |
