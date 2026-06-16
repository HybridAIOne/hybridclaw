---
title: Statement of Applicability
description: Working ISO/IEC 27001:2022 Annex A applicability statement for HybridClaw.
sidebar_position: 2
---

# Statement of Applicability

Review date: 2026-06-16.

This SoA uses grouped Annex A control areas to match the public control matrix.
The purchased ISO standard remains the normative source for individual control
wording.

| Annex A area | Applicable | Owner | Implementation status | Evidence | Residual risk |
| --- | --- | --- | --- | --- | --- |
| A.5.1-A.5.3 Policies, roles, segregation | Yes | ISMS Owner | Partial | `SECURITY.md`, `TRUST_MODEL.md`, [Control Owners](./control-owners.md) | Formal management approval remains operator-owned. |
| A.5.4-A.5.8 Management, contacts, threat intelligence, project security | Yes | ISMS Owner | Partial | PR template, threat model, [Evidence Calendar](./evidence-calendar.md) | Threat-intel source review needs recurring records. |
| A.5.9-A.5.11 Asset inventory, acceptable use, return of assets | Yes | Asset Owner | Partial | [Asset And Data Inventory](./asset-data-inventory.md) | Endpoint and personnel asset records are external. |
| A.5.12-A.5.14 Classification, labelling, transfer | Yes | Data Owner | Partial | Threat model secret classes, [Asset And Data Inventory](./asset-data-inventory.md) | Organization-wide labels need operator adoption. |
| A.5.15-A.5.18 Access control and authentication information | Yes | Access Owner | Partial | [Access-Control Matrix](./access-control-matrix.md), `src/security/admin-rbac.ts` | Periodic access review evidence must be collected. |
| A.5.19-A.5.23 Supplier and cloud services | Yes | Supplier Owner | Partial | [Supplier Register](./supplier-register.md) | DPA and supplier security reviews are external. |
| A.5.24-A.5.30 Incident management and ICT readiness | Yes | Incident Owner | Partial | `SECURITY.md`, `TRUST_MODEL.md`, [Evidence Calendar](./evidence-calendar.md) | Tabletop and continuity exercises need records. |
| A.5.31-A.5.34 Legal, IP, records, privacy, PII | Yes | Privacy Owner | Partial | [Asset And Data Inventory](./asset-data-inventory.md) | Legal obligations and processing register are operator-owned. |
| A.5.35-A.5.37 Independent review, compliance, procedures | Yes | ISMS Owner | Partial | CI workflows, [Review Sign-Off](./review-signoff.md) | Independent review evidence is pending. |
| A.6.1-A.6.8 People controls | Yes | People Owner | Operator evidence | [Control Owners](./control-owners.md) | HR records stay outside this repo. |
| A.7.1-A.7.14 Physical controls | Yes | Facilities Owner | Operator evidence | [Control Owners](./control-owners.md) | Facilities and hosting evidence stay outside this repo. |
| A.8.1-A.8.3 Endpoint devices, privileged rights, access restriction | Yes | Access Owner | Partial | [Access-Control Matrix](./access-control-matrix.md), approval policy docs | Endpoint hardening evidence is external. |
| A.8.4 Source-code access | Yes | Engineering Owner | Partial | CI workflows, PR template | Branch protection and repository permission review evidence is external. |
| A.8.5 Secure authentication | Yes | Access Owner | Partial | HttpOnly session cookies, no browser token persistence, [Access-Control Matrix](./access-control-matrix.md) | Remote MFA/SSO evidence remains operator-owned. |
| A.8.6 Capacity management | Yes | Operations Owner | Partial | Request-size limits, container resource docs | Production metrics and thresholds need operating records. |
| A.8.7 Malware protection | Yes | Operations Owner | Partial | Docker isolation, npm install controls | Runner/endpoint malware evidence is external. |
| A.8.8 Technical vulnerabilities | Yes | Engineering Owner | Partial | Dependency audit workflow | SAST/secret scanning evidence and SLAs need completion. |
| A.8.9 Configuration management | Yes | Operations Owner | Partial | `config.example.json`, `.hybridclaw/policy.yaml` | Production drift review evidence is external. |
| A.8.10-A.8.12 Deletion, masking, DLP | Yes | Data Owner | Partial | Confidential filter, audit leak scanner | Retention/deletion procedure needs operator execution records. |
| A.8.13-A.8.14 Backup and redundancy | Yes | Operations Owner | Operator evidence | `TRUST_MODEL.md` responsibility assignment | Backup/restore tests are external. |
| A.8.15-A.8.16 Logging and monitoring | Yes | Audit Owner | Partial | Hash-chained audit logs, runtime docs | Off-host sink and alert records remain open. |
| A.8.17 Clock synchronization | Yes | Operations Owner | Operator evidence | [Evidence Calendar](./evidence-calendar.md) | Host NTP evidence is external. |
| A.8.18 Privileged utility programs | Yes | Access Owner | Partial | Approval policy docs, tool blocking | Privileged utility inventory needs recurring review. |
| A.8.19 Software installation | Yes | Engineering Owner | Partial | npm release-age and lockfile policy | Host install policy evidence is external. |
| A.8.20-A.8.23 Network controls | Yes | Operations Owner | Partial | Container isolation, mount allowlists | Production network diagrams and firewall reviews are external. |
| A.8.24 Cryptography | Yes | Security Owner | Partial | Runtime secrets AES-256-GCM docs/source | KMS/key custody records are external. |
| A.8.25-A.8.29 Secure development | Yes | Engineering Owner | Partial | Threat-model guidance, CI tests | Security test traceability and release sign-off need records. |
| A.8.30 Outsourced development | Conditional | People Owner | Operator evidence | [Control Owners](./control-owners.md) | Contractor evidence required only when used. |
| A.8.31-A.8.34 Environment separation, change, test info, audit testing | Yes | Engineering Owner | Partial | CI separation, PR validation | Production environment and change-approval evidence is external. |
