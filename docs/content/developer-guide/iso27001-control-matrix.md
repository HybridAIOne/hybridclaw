---
title: ISO/IEC 27001 Control Matrix
description: Working ISO/IEC 27001:2022 and ISO/IEC 27001:2022/Amd 1:2024 evidence and gap matrix for HybridClaw.
sidebar_position: 8
---

# ISO/IEC 27001 Control Matrix

This is a working compliance support artifact, not a certification claim. It
maps repo-visible HybridClaw evidence to ISO/IEC 27001:2022 Annex A control
areas and highlights the biggest evidence gaps an auditor would ask about.

Control intent is paraphrased. Use the purchased ISO standard for normative
control wording.

## Standard Reference Check

- Reviewed against the ISO-published current reference
  [ISO/IEC 27001:2022](https://www.iso.org/standard/27001) on 2026-06-16.
- ISO lists ISO/IEC 27001:2022 as published, Edition 3, publication date
  2022-10. ISO also lists ISO/IEC 27001:2022/Amd 1:2024 for climate-action
  changes.
- This matrix maps the ISO/IEC 27001:2022 Annex A control areas. It is not a
  complete management-system clause checklist; add clauses 4-10, including the
  amendment-driven climate context check, before treating the package as
  audit-ready.
- Short form "ISO 27001" is used only in headings and navigation when brevity
  helps. Evidence and certification claims should use the full reference
  "ISO/IEC 27001:2022".

## Scope And Assumptions

- Review date: 2026-06-17.
- Scope: this repository, bundled docs, CI/CD workflows, and source-visible
  security controls.
- Out of scope: company ISMS records, HR records, contracts, cloud account
  configuration, endpoint management, physical facilities, customer DPAs, and
  edge proxy/WAF/SIEM settings unless represented in this repo.
- Status values:
  - `Evidence`: repo contains concrete implementation or documentation.
  - `Partial`: repo contains useful evidence, but ISO-ready operating evidence
    or technical coverage is incomplete.
  - `Gap`: no sufficient repo-visible evidence.
  - `Operator evidence`: primarily proven outside the product repo.
- File and line references are from the checkout reviewed on the date above and
  should be refreshed after substantive edits.

## Readiness Snapshot

Current ISO/IEC 27001 Annex A evidence readiness is **46%**.

This is a planning score, not an audit or certification claim. It is calculated
from the 29 grouped Annex A rows below with these weights:

| Status | Weight | Count | Weighted points |
| --- | --- | ---: | ---: |
| `Evidence` | 1.00 | 0 | 0.00 |
| `Partial` | 0.50 | 24 | 12.00 |
| `Operator evidence` | 0.25 | 5 | 1.25 |
| `Gap` | 0.00 | 0 | 0.00 |
| **Total** |  | **29** | **13.25 / 29 = 46%** |

The repo now has an initial ISO evidence package, supplier register, asset/data
inventory, audit/monitoring matrix, owner map, calendar, sign-off trail, Docker
image SBOM/provenance settings, CodeQL SAST, and a tracked secret-scanning
workflow. The score remains 46% under this coarse grouped-control rubric because
the affected rows still need operating evidence with named owners, review dates,
external records, vulnerability SLAs, remediation tracking, and production
proof before they can move from `Partial` to `Evidence`.

## TISAX Fit

TISAX is worth preparing for only if automotive customers, suppliers, or
partners ask for it. It is not an ISO certificate and should not replace the
ISO/IEC 27001 path for general enterprise procurement.

Use this ISO/IEC 27001 matrix as a foundation for TISAX evidence, then maintain
a separate VDA ISA self-assessment because ENX runs TISAX as an assessment and
exchange mechanism around the VDA ISA catalogue. ENX describes the ISA as an
information-security requirements catalogue based on key aspects of
ISO/IEC 27001, and its downloads page says ISA 6 is the basis for TISAX
assessments ordered after 2024-04-01. TISAX readiness still needs:

- ENX participant registration and assessment scope records.
- Selected assessment objectives, protection needs, and assessment level.
- VDA ISA 6.x self-assessment with maturity-level evidence.
- Audit-provider selection, corrective action plan records, and exchange
  release decisions.

## Immediate Gap Register

| ID | Priority | ISO refs | Gap | Repo evidence | Next evidence or control |
| --- | --- | --- | --- | --- | --- |
| G-001 | P1 | A.5.1, A.5.8, A.5.35, A.5.36 | ISO evidence package now exists, but operator review/sign-off and external operating records remain pending. | Working package lives in [`docs/content/developer-guide/iso27001/`](./iso27001/), including SoA, risk register, asset/data inventory, access control, audit/monitoring, owners, evidence calendar, supplier register, and sign-off trail. | Complete management/operator sign-off and attach external evidence references. |
| G-002 | P1 | A.5.15, A.5.16, A.5.18, A.8.2, A.8.3 | Admin RBAC has route-level actions and role bundles; the remaining gap is real user assignment and periodic access-review evidence. | Scoped action names, route mapping, and role bundles live in [`src/security/admin-rbac.ts`](../../../src/security/admin-rbac.ts). The access-control record is [`docs/content/developer-guide/iso27001/access-control-matrix.md`](./iso27001/access-control-matrix.md). | Record actual admin subjects, role assignments, MFA/SSO evidence, and monthly/quarterly access reviews. |
| G-003 | Closed | A.5.17, A.8.5, A.8.24, A.8.28 | Admin console token handling was hardened for the repo-visible surfaces in scope. | Local and HybridAI-launched consoles use HttpOnly cookies in [`src/gateway/gateway-http-server.ts`](../../../src/gateway/gateway-http-server.ts). Browser token localStorage/query bootstrap is removed in [`console/src/api/client.ts`](../../../console/src/api/client.ts), `/api/events` no longer accepts query-token auth, and console responses include CSP/security headers. | Prefer signed sessions over manual token entry and keep remote MFA/SSO evidence in the operator ISMS. |
| G-004 | P1 | A.5.28, A.5.33, A.8.15, A.8.16 | Audit is tamper-evident locally and now mapped in an evidence matrix, but not ISO-ready retention/monitoring: no WORM or off-host sink, no SIEM alerting evidence, and privileged-action coverage needs a complete event catalog. | Hash-chained wire logs are appended in [`src/audit/audit-trail.ts`](../../../src/audit/audit-trail.ts). Non-strict audit writes warn on failure in [`src/audit/audit-events.ts`](../../../src/audit/audit-events.ts). The initial audit evidence matrix is [`docs/content/developer-guide/iso27001/audit-monitoring-matrix.md`](./iso27001/audit-monitoring-matrix.md). | Add a privileged-action event catalog, export/off-host sink, retention policy, alert rules, quarterly audit verification samples, and incident linkage evidence. |
| G-005 | P1 | A.5.12, A.5.31, A.5.34, A.8.10, A.8.11, A.8.12, A.8.13 | Data lifecycle is now inventoried at a starter level, but retention, deletion, backup/restore, privacy obligations, and PII processing records remain operator-owned gaps. | The starter data inventory is [`docs/content/developer-guide/iso27001/asset-data-inventory.md`](./iso27001/asset-data-inventory.md). [`TRUST_MODEL.md`](../../../TRUST_MODEL.md) says operators are responsible for retention, backup, and deletion. Confidential redaction is configurable and disabled in [`config.example.json`](../../../config.example.json). | Add classification labels, retention/deletion policy, backup/restore runbook, privacy register, subject-rights workflow, and testable deletion evidence. |
| G-006 | P2 | A.5.21, A.8.8, A.8.25, A.8.28, A.8.29 | Container SBOM/provenance, SAST, and secret scanning are now repo-visible. The remaining gap is vulnerability-management operating evidence: SLAs, triage ownership, remediation tracking, exception handling, and release security sign-off. | npm audit and signature verification are in [`.github/workflows/dependency-audit.yml`](../../../.github/workflows/dependency-audit.yml). Docker image SBOM/provenance is enabled in [`.github/workflows/docker-build.yml`](../../../.github/workflows/docker-build.yml) and [`.github/workflows/publish-release.yml`](../../../.github/workflows/publish-release.yml). CodeQL and secret scanning run from [`.github/workflows/security-scan.yml`](../../../.github/workflows/security-scan.yml), backed by [`scripts/secret-scan.mjs`](../../../scripts/secret-scan.mjs). | Define vulnerability SLAs, triage ownership, remediation tracking, release security sign-off, and exception records. |
| G-007 | P1 | A.5.19, A.5.20, A.5.21, A.5.22, A.5.23 | A starter supplier register now exists, but DPA/security reviews, subprocessor checks, enabled-service approvals, and exit-plan evidence are still missing. | The supplier register is [`docs/content/developer-guide/iso27001/supplier-register.md`](./iso27001/supplier-register.md). Provider/channel dependencies are visible in [`package.json`](../../../package.json) and related docs. | Complete supplier records with service owner, data categories, legal basis/DPA status, security review, subprocessor review, monitoring cadence, and exit plan. |
| G-008 | P2 | A.5.24, A.5.25, A.5.26, A.5.27, A.5.29, A.5.30, A.8.14 | Incident response and business continuity are documented as emergency steps, but not as an exercised program. | Incident steps are in [`SECURITY.md`](../../../SECURITY.md) and [`TRUST_MODEL.md`](../../../TRUST_MODEL.md). | Add severity definitions, escalation contacts, tabletop records, backup/restore tests, RTO/RPO targets, and post-incident review templates. |
| G-009 | P2 | A.5.17, A.8.24 | Runtime secret encryption is strong, but key custody and rotation policy are not ISO-ready. | Runtime secrets use a master key from env, mounted secret, or local fallback in [`src/security/runtime-secrets.ts:330`](../../../src/security/runtime-secrets.ts), with AES-256-GCM in [`src/security/runtime-secrets.ts:378`](../../../src/security/runtime-secrets.ts). | Define KMS/HSM or mounted-secret guidance, rotation cadence, recovery procedure, break-glass controls, and key-access audit evidence. |
| G-010 | P2 | A.8.6, A.8.16, A.8.20, A.8.21 | Abuse controls and operational monitoring need runtime evidence. Code has request-size limits and container constraints, but no repo-visible global API throttling, alert thresholds, or capacity plan. | JSON body limits are enforced in [`src/gateway/gateway-http-utils.ts:12`](../../../src/gateway/gateway-http-utils.ts). Container isolation is documented in [`SECURITY.md`](../../../SECURITY.md). | Add production rate-limit policy, capacity metrics, alerting runbooks, and gateway abuse-event audit coverage. |
| G-011 | P2 | Clauses 4-10, ISO/IEC 27001:2022/Amd 1:2024 | This matrix is Annex A focused and does not yet prove current management-system clause coverage, including the climate-context consideration introduced by the 2024 amendment. | The review date and standard reference are documented above, but no clause-by-clause checklist exists. | Add an ISMS clause checklist covering context, interested parties, scope, leadership, planning, support, operation, performance evaluation, improvement, and the amendment-driven climate question. |

## Annex A Coverage Matrix

| Annex A area | Status | Repo-visible evidence | Main gap to close |
| --- | --- | --- | --- |
| A.5.1-A.5.3 Information security policies, roles, and segregation | Partial | [`SECURITY.md`](../../../SECURITY.md), [`TRUST_MODEL.md`](../../../TRUST_MODEL.md), and the PR template require risk notes and secret-handling review in [`.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md). | Convert product security docs into an ISMS policy set with named owners, approval dates, review cadence, and role/accountability matrix. |
| A.5.4-A.5.8 Management responsibilities, external contacts, threat intelligence, and project security | Partial | PR template asks for security-sensitive path notes and failure modes. Secret-adjacent feature review is documented in [`docs/content/developer-guide/threat-model.md`](./threat-model.md). | Add threat-intelligence sources, project security gate criteria, management sign-off, and evidence of recurring review. |
| A.5.9-A.5.11 Asset inventory, acceptable use, and return of assets | Partial | Product assets and data stores are tracked in [`docs/content/developer-guide/iso27001/asset-data-inventory.md`](./iso27001/asset-data-inventory.md). | Add operator endpoint, production host, and personnel asset records. |
| A.5.12-A.5.14 Information classification, labelling, and transfer | Partial | Secret classes and sensitive non-secret data are defined in [`docs/content/developer-guide/threat-model.md`](./threat-model.md). Optional confidential filtering is documented in [`SECURITY.md`](../../../SECURITY.md). | Add organization-wide classification labels, data transfer rules, approved destinations, and evidence that classification drives controls. |
| A.5.15-A.5.18 Access control, identity, authentication information, and access rights | Partial | Scoped admin route actions and role bundles are mapped in [`src/security/admin-rbac.ts`](../../../src/security/admin-rbac.ts). Token/session handling and review procedure are documented in [`docs/content/developer-guide/iso27001/access-control-matrix.md`](./iso27001/access-control-matrix.md). | Add access-request/review/revocation evidence and MFA/IdP records for actual admin subjects. |
| A.5.19-A.5.23 Supplier relationships and cloud services | Partial | Third-party service dependencies are visible in [`package.json`](../../../package.json) and channel/provider docs. A starter supplier register exists in [`docs/content/developer-guide/iso27001/supplier-register.md`](./iso27001/supplier-register.md). | Complete supplier security reviews, DPA/subprocessor evidence, monitoring records, enabled-service approvals, and exit plans. |
| A.5.24-A.5.30 Incident management and ICT readiness | Partial | Incident steps exist in [`SECURITY.md`](../../../SECURITY.md) and [`TRUST_MODEL.md`](../../../TRUST_MODEL.md). Audit commands are documented in [`docs/content/developer-guide/runtime.md`](./runtime.md). | Add formal incident roles, escalation paths, evidence collection rules, lessons-learned records, continuity tests, and communication templates. |
| A.5.31-A.5.34 Legal, IP, records, privacy, and PII | Partial | License metadata, product trust docs, and starter data inventory exist in [`docs/content/developer-guide/iso27001/asset-data-inventory.md`](./iso27001/asset-data-inventory.md). | Add legal/register-of-processing evidence, PII inventory, retention schedule, deletion workflow, records ownership, and customer-facing privacy commitments. |
| A.5.35-A.5.37 Independent review, policy compliance, and procedures | Partial | Automated CI and release checks exist in [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). Runtime operating notes exist in docs. | Add independent security review schedule, compliance review evidence, operating procedures, and exception handling. |
| A.6.1-A.6.8 People controls | Operator evidence | No HR or personnel controls should live in product source by default. | Keep screening, terms, awareness training, disciplinary process, termination/offboarding, confidentiality, remote work, and event reporting evidence in the organization ISMS. |
| A.7.1-A.7.14 Physical controls | Operator evidence | No facility, office, datacenter, or endpoint physical controls are represented in this repo. | Link the SoA to office/cloud/hosting physical security evidence, visitor controls, secure disposal, and endpoint handling records. |
| A.8.1-A.8.3 User endpoint devices, privileged rights, and access restriction | Partial | Runtime tool approval tiers are documented in [`SECURITY.md`](../../../SECURITY.md). Scoped admin route actions and role bundles are enforced for session claims. | Define endpoint hardening expectations for operators and collect privileged access-review evidence. |
| A.8.4 Access to source code | Partial | CI requires lint, typecheck, tests, release checks, and Docker preflight in [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). | Branch protection, CODEOWNERS, required reviews, and repository permission reviews are not visible in the repo. |
| A.8.5 Secure authentication | Partial | Gateway auth supports bearer tokens, signed session cookies, and local HttpOnly web sessions in [`src/gateway/gateway-http-server.ts`](../../../src/gateway/gateway-http-server.ts). Console token persistence and SSE query-token auth are removed. | Add MFA/SSO evidence for remote administration and operator token/session review records. |
| A.8.6 Capacity management | Partial | Container resource constraints are documented in [`SECURITY.md`](../../../SECURITY.md), and request-size limits exist in [`src/gateway/gateway-http-utils.ts:12`](../../../src/gateway/gateway-http-utils.ts). | Add capacity baselines, runtime metrics, load thresholds, and alert response evidence. |
| A.8.7 Protection against malware | Partial | npm lifecycle scripts are disabled in dependency-audit installs, Docker isolation is documented, and secret scanning runs in [`.github/workflows/security-scan.yml`](../../../.github/workflows/security-scan.yml). | Add endpoint/runner malware protection evidence and document how scan findings are triaged. |
| A.8.8 Management of technical vulnerabilities | Partial | Scheduled npm audit and signature verification run in [`.github/workflows/dependency-audit.yml`](../../../.github/workflows/dependency-audit.yml). CodeQL SAST and secret scanning run in [`.github/workflows/security-scan.yml`](../../../.github/workflows/security-scan.yml). | Add vulnerability SLAs, triage ownership, remediation tracking, release security sign-off, and exception records. |
| A.8.9 Configuration management | Partial | Example config exists in [`config.example.json`](../../../config.example.json), policy is repo-controlled through `.hybridclaw/policy.yaml`, and CI checks dependency policy. | Add secure configuration baselines, drift checks, configuration owner reviews, and production config evidence. |
| A.8.10-A.8.12 Information deletion, data masking, and data leakage prevention | Partial | Optional confidential filtering and audit leak scanning are documented in [`SECURITY.md`](../../../SECURITY.md). | Add deletion workflows, retention enforcement, DLP coverage, data masking rules, and privacy test evidence. |
| A.8.13-A.8.14 Backup and redundancy | Operator evidence | [`TRUST_MODEL.md`](../../../TRUST_MODEL.md) assigns backup and retention responsibility to operators, and the evidence calendar requires quarterly restore-test records. | Add backup schedule, restore tests, RTO/RPO, redundancy architecture, and owner sign-off. |
| A.8.15-A.8.16 Logging and monitoring | Partial | Audit wire logs are hash-chained in [`src/audit/audit-trail.ts`](../../../src/audit/audit-trail.ts). Audit commands are documented in [`docs/content/developer-guide/runtime.md`](./runtime.md). | Add off-host retention, monitoring alerts, audit coverage mapping, and procedures for audit failure handling. |
| A.8.17 Clock synchronization | Operator evidence | No NTP or host time configuration is visible in app code. | Record NTP/time-sync controls for production hosts, CI runners, and log aggregation systems. |
| A.8.18 Use of privileged utility programs | Partial | Tool blocking and approval controls are documented in [`SECURITY.md`](../../../SECURITY.md). | Inventory privileged utilities, define allowed use cases, and audit high-risk tool execution consistently. |
| A.8.19 Installation of software on operational systems | Partial | npm release-age, exact-save, shrinkwrap, and dependency verification are documented in [`SECURITY.md`](../../../SECURITY.md). | Add host and runner software-installation policies plus evidence of approved installation paths. |
| A.8.20-A.8.23 Network controls, network services, segregation, and web filtering | Partial | Container isolation and mount allowlists are documented in [`SECURITY.md`](../../../SECURITY.md). Remote access docs describe token-auth requirements. | Add production network architecture, firewall/egress policy, segmentation, web filtering, and review evidence. |
| A.8.24 Use of cryptography | Partial | Runtime secrets use AES-256-GCM and local permission controls in [`src/security/runtime-secrets.ts`](../../../src/security/runtime-secrets.ts). | Add cryptographic policy, key custody/rotation/recovery records, algorithm review, and external KMS guidance. |
| A.8.25-A.8.29 Secure development lifecycle, app security requirements, architecture, coding, and testing | Partial | Threat-model review guidance exists in [`docs/content/developer-guide/threat-model.md`](./threat-model.md). CI runs build, lint, tests, release checks, coverage, Docker preflight, CodeQL SAST, and secret scanning. | Add security requirements traceability, DAST or pen-test evidence where applicable, secure coding standard acceptance, and release security sign-off. |
| A.8.30 Outsourced development | Operator evidence | No outsourced development process is visible in the repo. | Track third-party contributors, contractor access, contractual security terms, review requirements, and offboarding evidence. |
| A.8.31-A.8.34 Environment separation, change management, test information, and audit testing | Partial | CI separates build/test workflows and the PR template requires validation evidence. | Add production/staging/dev separation evidence, formal change approvals, test-data handling rules, and audit-test procedures. |

## Evidence Package To Maintain Next

The initial evidence package lives in [`docs/content/developer-guide/iso27001/`](./iso27001/).
Before treating it as audit-ready, complete these operator records:

1. Management sign-off for the SoA, control owners, residual risks, and the
   current 46% readiness baseline.
2. Actual admin subject inventory, role assignments, MFA/SSO evidence, and
   access-review records.
3. Production asset inventory for hosts, endpoints, backups, and network
   controls outside this repository.
4. Audit and monitoring matrix with event catalog, source, retention, alerting,
   off-host sink, integrity verification, and incident linkage.
5. Supplier DPA/security review evidence for enabled providers and channels.
6. Retention/deletion, backup/restore, and incident tabletop records.

## Engineering Work Items

These are the highest-value code or repo changes that would improve the matrix:

1. Map all privileged mutations to structured audit events and add an off-host
   audit export path.
2. Define vulnerability SLAs, remediation tracking, exception handling, and
   release security sign-off records for CI findings.
3. Add an ISMS clauses 4-10 checklist, including the
   ISO/IEC 27001:2022/Amd 1:2024 climate-context consideration.
