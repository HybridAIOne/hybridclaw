---
title: ISO 27001 Control Matrix
description: Working ISO/IEC 27001:2022 Annex A evidence and gap matrix for HybridClaw.
sidebar_position: 8
---

# ISO 27001 Control Matrix

This is a working compliance support artifact, not a certification claim. It
maps repo-visible HybridClaw evidence to ISO/IEC 27001:2022 Annex A control
areas and highlights the biggest evidence gaps an auditor would ask about.

Control intent is paraphrased. Use the purchased ISO standard for normative
control wording.

## Scope And Assumptions

- Review date: 2026-06-16.
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

## Immediate Gap Register

| ID | Priority | Annex A refs | Gap | Repo evidence | Next evidence or control |
| --- | --- | --- | --- | --- | --- |
| G-001 | P0 | A.5.1, A.5.8, A.5.35, A.5.36 | No ISO evidence package: no visible Statement of Applicability, ISMS risk register, asset inventory, control owners, review cadence, or effectiveness evidence. | Runtime security docs exist in [`SECURITY.md`](../../../SECURITY.md) and [`TRUST_MODEL.md`](../../../TRUST_MODEL.md). Repo search only found generic "risk register" examples, not an ISMS register. | Create an ISMS evidence folder with SoA, risk register, asset/data inventory, control owner table, evidence calendar, and review sign-off trail. |
| G-002 | P0 | A.5.15, A.5.16, A.5.18, A.8.2, A.8.3 | Admin RBAC now has route-level actions and code-backed role bundles for scoped sessions, but the ISO gap remains until sessions and tokens are issued through a documented workflow and periodic access reviews exist. | Broad bearer credentials are still accepted for compatibility in [`src/gateway/gateway-http-server.ts:2046`](../../../src/gateway/gateway-http-server.ts). Scoped admin action names, route mapping, and role bundles live in [`src/security/admin-rbac.ts`](../../../src/security/admin-rbac.ts). Role intent and review evidence are documented in [`Admin Access Control`](./admin-access-control.md). | Issue scoped sessions with role claims, record approval/expiration evidence, run quarterly access reviews, and reduce broad bearer-token use to break-glass paths. |
| G-003 | P0 | A.5.17, A.8.5, A.8.24, A.8.28 | Admin console token handling is partially hardened: signed session cookies can authorize same-origin API calls, manual bearer-token fallback is tab-scoped, and SSE no longer accepts query-token auth. The remaining ISO gap is browser-token lifetime/rotation evidence and full CSP/security-header coverage for the admin console. | Session-cookie API auth is enforced in [`src/gateway/gateway-http-server.ts`](../../../src/gateway/gateway-http-server.ts). Console token fallback uses `sessionStorage` and removes legacy `localStorage` copies in [`console/src/api/client.ts`](../../../console/src/api/client.ts). Admin EventSource URLs omit bearer tokens in [`console/src/hooks/use-live-events.ts`](../../../console/src/hooks/use-live-events.ts). | Add CSP and security headers for the built admin console, define token/session lifetime and rotation policy, and move remaining manual-token flows to short-lived scoped sessions where possible. |
| G-004 | P1 | A.5.28, A.5.33, A.8.15, A.8.16 | Audit is tamper-evident locally, but not ISO-ready retention/monitoring: no WORM or off-host sink, no SIEM alerting evidence, and admin mutation audit coverage is not mapped end to end. | Hash-chained wire logs are appended in [`src/audit/audit-trail.ts:232`](../../../src/audit/audit-trail.ts). Non-strict audit writes warn on failure in [`src/audit/audit-events.ts:29`](../../../src/audit/audit-events.ts). Runtime docs describe audit verification in [`docs/content/developer-guide/runtime.md`](./runtime.md). | Add an audit coverage matrix, privileged-action event catalog, export/off-host sink, retention policy, alert rules, and verification evidence. |
| G-005 | P1 | A.5.12, A.5.31, A.5.34, A.8.10, A.8.11, A.8.12, A.8.13 | Data lifecycle is mostly operator-owned. There is no central retention schedule, deletion workflow, data classification register, backup/restore evidence, or PII processing inventory. | [`TRUST_MODEL.md`](../../../TRUST_MODEL.md) says operators are responsible for retention, backup, and deletion. Confidential redaction is configurable and disabled in [`config.example.json:3`](../../../config.example.json). | Add a data inventory, classification labels, retention/deletion policy, backup/restore runbook, privacy register, and testable deletion workflows. |
| G-006 | P1 | A.5.21, A.8.8, A.8.25, A.8.28, A.8.29 | Supply-chain controls are good for npm but incomplete for container artifacts and application security testing. Docker SBOM and provenance are disabled, and repo-visible SAST/secret-scanning evidence is not present. | npm audit and signature verification are in [`.github/workflows/dependency-audit.yml`](../../../.github/workflows/dependency-audit.yml). Docker release builds set `provenance: false` and `sbom: false` in [`.github/workflows/publish-release.yml:165`](../../../.github/workflows/publish-release.yml). | Enable image SBOM/provenance, add SAST/secret scanning evidence, define vulnerability SLAs, and track remediation through issues/releases. |
| G-007 | P1 | A.5.19, A.5.20, A.5.21, A.5.22, A.5.23 | Supplier and cloud-service governance is not represented in the repo. HybridClaw integrates with multiple model, channel, and infrastructure services, but no supplier inventory or DPA/security review evidence is visible. | Provider/channel dependencies are visible in [`package.json`](../../../package.json), but supplier risk artifacts are out of repo scope. | Maintain a supplier register with service owner, data categories, legal basis/DPA status, security review, subprocessor review, and exit plan. |
| G-008 | P2 | A.5.24, A.5.25, A.5.26, A.5.27, A.5.29, A.5.30, A.8.14 | Incident response and business continuity are documented as emergency steps, but not as an exercised program. | Incident steps are in [`SECURITY.md`](../../../SECURITY.md) and [`TRUST_MODEL.md`](../../../TRUST_MODEL.md). | Add severity definitions, escalation contacts, tabletop records, backup/restore tests, RTO/RPO targets, and post-incident review templates. |
| G-009 | P2 | A.5.17, A.8.24 | Runtime secret encryption is strong, but key custody and rotation policy are not ISO-ready. | Runtime secrets use a master key from env, mounted secret, or local fallback in [`src/security/runtime-secrets.ts:330`](../../../src/security/runtime-secrets.ts), with AES-256-GCM in [`src/security/runtime-secrets.ts:378`](../../../src/security/runtime-secrets.ts). | Define KMS/HSM or mounted-secret guidance, rotation cadence, recovery procedure, break-glass controls, and key-access audit evidence. |
| G-010 | P2 | A.8.6, A.8.16, A.8.20, A.8.21 | Abuse controls and operational monitoring need runtime evidence. Code has request-size limits and container constraints, but no repo-visible global API throttling, alert thresholds, or capacity plan. | JSON body limits are enforced in [`src/gateway/gateway-http-utils.ts:12`](../../../src/gateway/gateway-http-utils.ts). Container isolation is documented in [`SECURITY.md`](../../../SECURITY.md). | Add production rate-limit policy, capacity metrics, alerting runbooks, and gateway abuse-event audit coverage. |

## Annex A Coverage Matrix

| Annex A area | Status | Repo-visible evidence | Main gap to close |
| --- | --- | --- | --- |
| A.5.1-A.5.3 Information security policies, roles, and segregation | Partial | [`SECURITY.md`](../../../SECURITY.md), [`TRUST_MODEL.md`](../../../TRUST_MODEL.md), and the PR template require risk notes and secret-handling review in [`.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md). | Convert product security docs into an ISMS policy set with named owners, approval dates, review cadence, and role/accountability matrix. |
| A.5.4-A.5.8 Management responsibilities, external contacts, threat intelligence, and project security | Partial | PR template asks for security-sensitive path notes and failure modes. Secret-adjacent feature review is documented in [`docs/content/developer-guide/threat-model.md`](./threat-model.md). | Add threat-intelligence sources, project security gate criteria, management sign-off, and evidence of recurring review. |
| A.5.9-A.5.11 Asset inventory, acceptable use, and return of assets | Gap | Product assets and data stores are described across docs, but no ISO asset register is visible. | Create an asset inventory for code, data stores, secrets, CI/CD systems, images, channels, providers, and runtime hosts. |
| A.5.12-A.5.14 Information classification, labelling, and transfer | Partial | Secret classes and sensitive non-secret data are defined in [`docs/content/developer-guide/threat-model.md`](./threat-model.md). Optional confidential filtering is documented in [`SECURITY.md`](../../../SECURITY.md). | Add organization-wide classification labels, data transfer rules, approved destinations, and evidence that classification drives controls. |
| A.5.15-A.5.18 Access control, identity, authentication information, and access rights | Partial | Bearer-token API auth is implemented in [`src/gateway/gateway-http-server.ts:2046`](../../../src/gateway/gateway-http-server.ts). Scoped admin route actions and role bundles are mapped in [`src/security/admin-rbac.ts`](../../../src/security/admin-rbac.ts), with review guidance in [`Admin Access Control`](./admin-access-control.md). | Add access-request/review/revocation records, token/session issuance evidence, and MFA/IdP expectations for remote admin access. |
| A.5.19-A.5.23 Supplier relationships and cloud services | Gap | Third-party service dependencies are visible in [`package.json`](../../../package.json) and channel/provider docs. | Maintain supplier and cloud-service registers, security review records, DPA/subprocessor evidence, monitoring, and exit plans. |
| A.5.24-A.5.30 Incident management and ICT readiness | Partial | Incident steps exist in [`SECURITY.md`](../../../SECURITY.md) and [`TRUST_MODEL.md`](../../../TRUST_MODEL.md). Audit commands are documented in [`docs/content/developer-guide/runtime.md`](./runtime.md). | Add formal incident roles, escalation paths, evidence collection rules, lessons-learned records, continuity tests, and communication templates. |
| A.5.31-A.5.34 Legal, IP, records, privacy, and PII | Gap | License metadata and product trust docs exist, but no privacy/legal obligation register is visible. | Add legal/register-of-processing evidence, PII inventory, retention schedule, deletion workflow, records ownership, and customer-facing privacy commitments. |
| A.5.35-A.5.37 Independent review, policy compliance, and procedures | Partial | Automated CI and release checks exist in [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). Runtime operating notes exist in docs. | Add independent security review schedule, compliance review evidence, operating procedures, and exception handling. |
| A.6.1-A.6.8 People controls | Operator evidence | No HR or personnel controls should live in product source by default. | Keep screening, terms, awareness training, disciplinary process, termination/offboarding, confidentiality, remote work, and event reporting evidence in the organization ISMS. |
| A.7.1-A.7.14 Physical controls | Operator evidence | No facility, office, datacenter, or endpoint physical controls are represented in this repo. | Link the SoA to office/cloud/hosting physical security evidence, visitor controls, secure disposal, and endpoint handling records. |
| A.8.1-A.8.3 User endpoint devices, privileged rights, and access restriction | Partial | Runtime tool approval tiers are documented in [`SECURITY.md`](../../../SECURITY.md). Scoped admin route actions and role bundles are enforced for session claims. | Define endpoint hardening expectations for operators and collect privileged access-review evidence. |
| A.8.4 Access to source code | Partial | CI requires lint, typecheck, tests, release checks, and Docker preflight in [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). | Branch protection, CODEOWNERS, required reviews, and repository permission reviews are not visible in the repo. |
| A.8.5 Secure authentication | Partial | Gateway auth supports bearer tokens, signed session cookies, and local web sessions in [`src/gateway/gateway-http-server.ts`](../../../src/gateway/gateway-http-server.ts). Console fallback tokens are tab-scoped in [`console/src/api/client.ts`](../../../console/src/api/client.ts). | Add CSP/security headers, define token rotation and session lifetime policies, and add MFA/SSO evidence for remote administration. |
| A.8.6 Capacity management | Partial | Container resource constraints are documented in [`SECURITY.md`](../../../SECURITY.md), and request-size limits exist in [`src/gateway/gateway-http-utils.ts:12`](../../../src/gateway/gateway-http-utils.ts). | Add capacity baselines, runtime metrics, load thresholds, and alert response evidence. |
| A.8.7 Protection against malware | Partial | npm lifecycle scripts are disabled in dependency-audit installs, and Docker isolation is documented. | Add endpoint/runner malware protection evidence and supply-chain scanning coverage beyond npm audit. |
| A.8.8 Management of technical vulnerabilities | Partial | Scheduled npm audit and signature verification run in [`.github/workflows/dependency-audit.yml`](../../../.github/workflows/dependency-audit.yml). | Add SAST/secret scanning, vulnerability SLAs, triage ownership, remediation tracking, and exception records. |
| A.8.9 Configuration management | Partial | Example config exists in [`config.example.json`](../../../config.example.json), policy is repo-controlled through `.hybridclaw/policy.yaml`, and CI checks dependency policy. | Add secure configuration baselines, drift checks, configuration owner reviews, and production config evidence. |
| A.8.10-A.8.12 Information deletion, data masking, and data leakage prevention | Partial | Optional confidential filtering and audit leak scanning are documented in [`SECURITY.md`](../../../SECURITY.md). | Add deletion workflows, retention enforcement, DLP coverage, data masking rules, and privacy test evidence. |
| A.8.13-A.8.14 Backup and redundancy | Gap | [`TRUST_MODEL.md`](../../../TRUST_MODEL.md) assigns backup and retention responsibility to operators. | Add backup schedule, restore tests, RTO/RPO, redundancy architecture, and owner sign-off. |
| A.8.15-A.8.16 Logging and monitoring | Partial | Audit wire logs are hash-chained in [`src/audit/audit-trail.ts`](../../../src/audit/audit-trail.ts). Audit commands are documented in [`docs/content/developer-guide/runtime.md`](./runtime.md). | Add off-host retention, monitoring alerts, audit coverage mapping, and procedures for audit failure handling. |
| A.8.17 Clock synchronization | Operator evidence | No NTP or host time configuration is visible in app code. | Record NTP/time-sync controls for production hosts, CI runners, and log aggregation systems. |
| A.8.18 Use of privileged utility programs | Partial | Tool blocking and approval controls are documented in [`SECURITY.md`](../../../SECURITY.md). | Inventory privileged utilities, define allowed use cases, and audit high-risk tool execution consistently. |
| A.8.19 Installation of software on operational systems | Partial | npm release-age, exact-save, shrinkwrap, and dependency verification are documented in [`SECURITY.md`](../../../SECURITY.md). | Add host and runner software-installation policies plus evidence of approved installation paths. |
| A.8.20-A.8.23 Network controls, network services, segregation, and web filtering | Partial | Container isolation and mount allowlists are documented in [`SECURITY.md`](../../../SECURITY.md). Remote access docs describe token-auth requirements. | Add production network architecture, firewall/egress policy, segmentation, web filtering, and review evidence. |
| A.8.24 Use of cryptography | Partial | Runtime secrets use AES-256-GCM and local permission controls in [`src/security/runtime-secrets.ts`](../../../src/security/runtime-secrets.ts). | Add cryptographic policy, key custody/rotation/recovery records, algorithm review, and external KMS guidance. |
| A.8.25-A.8.29 Secure development lifecycle, app security requirements, architecture, coding, and testing | Partial | Threat-model review guidance exists in [`docs/content/developer-guide/threat-model.md`](./threat-model.md). CI runs build, lint, tests, release checks, coverage, and Docker preflight in [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). | Add security requirements traceability, SAST/DAST or pen-test evidence, secure coding standard acceptance, and release security sign-off. |
| A.8.30 Outsourced development | Operator evidence | No outsourced development process is visible in the repo. | Track third-party contributors, contractor access, contractual security terms, review requirements, and offboarding evidence. |
| A.8.31-A.8.34 Environment separation, change management, test information, and audit testing | Partial | CI separates build/test workflows and the PR template requires validation evidence. | Add production/staging/dev separation evidence, formal change approvals, test-data handling rules, and audit-test procedures. |

## Evidence Package To Build Next

Create these artifacts before treating this matrix as audit-ready:

1. `Statement of Applicability`: each Annex A control with applicable status,
   justification, implementation summary, owner, evidence link, and residual
   risk.
2. `Risk register`: asset, threat, vulnerability, existing control, likelihood,
   impact, treatment, owner, due date, and review status.
3. `Asset and data inventory`: source systems, data categories, PII/secrets
   status, retention period, backup class, owner, supplier, and location.
4. `Access-control matrix`: role bundles are documented in
   [`Admin Access Control`](./admin-access-control.md); still needed are
   token/session lifetime evidence, MFA expectations, approval workflow records,
   and periodic review records.
5. `Audit and monitoring matrix`: event catalog, source, retention, alerting,
   off-host sink, integrity verification, and incident linkage.
6. `Supplier register`: model providers, messaging providers, package
   registries, GitHub/GHCR, CI runners, hosting/cloud services, and subprocessors.

## Engineering Work Items

These are the highest-value code or repo changes that would improve the matrix:

1. Start issuing scoped admin sessions with the documented role bundles and
   collect approval, expiration, revocation, and quarterly review evidence.
2. Add a shared security-header helper for console and API responses, including
   CSP for the admin console.
3. Map all privileged mutations to structured audit events and add an off-host
   audit export path.
4. Enable Docker image SBOM and provenance for release images.
5. Add repo-visible SAST and secret-scanning workflows, or document the
   organization-level tooling that already covers them.
