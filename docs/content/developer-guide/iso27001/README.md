---
title: ISO 27001 Evidence Package
description: Working ISMS evidence package for HybridClaw ISO/IEC 27001:2022 support.
sidebar_position: 1
---

# ISO 27001 Evidence Package

This folder is a working evidence package for ISO/IEC 27001:2022 support. It is
not a certification claim. It separates repo-visible product controls from
operator-owned ISMS records that must be completed with real organizational
owners, dates, approvals, and operating evidence.

## Package Index

| Artifact | Purpose |
| --- | --- |
| [Statement of Applicability](./statement-of-applicability.md) | Annex A applicability, implementation status, owners, and evidence links. |
| [Risk Register](./risk-register.md) | Initial information-security risks, treatment, owners, and due dates. |
| [Asset And Data Inventory](./asset-data-inventory.md) | Systems, data categories, locations, owners, and retention classes. |
| [Access-Control Matrix](./access-control-matrix.md) | Admin roles, permissions, session/token handling, and access-review procedure. |
| [Control Owners](./control-owners.md) | Control ownership and RACI-style responsibilities. |
| [Evidence Calendar](./evidence-calendar.md) | Required evidence cadence and recurring review schedule. |
| [Audit And Monitoring Matrix](./audit-monitoring-matrix.md) | Event sources, retention, alerting, and audit-integrity evidence. |
| [Supplier Register](./supplier-register.md) | Initial supplier/cloud-service inventory and review requirements. |
| [Review Sign-Off](./review-signoff.md) | Evidence review log and pending operator sign-off trail. |

## Current Evidence State

| Area | State | Notes |
| --- | --- | --- |
| Repo evidence package | Created | Initial records are present in this folder and linked from the control matrix. |
| Admin RBAC | Implemented | Role bundles and scoped action claims are implemented in source. |
| Console token handling | Implemented | Console no longer persists `WEB_API_TOKEN` in browser storage or sends it in SSE URLs. |
| Operator sign-off | Pending | Business owners must review and sign the package outside a code-only workflow. |

## Maintenance Rules

- Update these records when security-sensitive code, provider integrations,
  admin access, audit logging, or data lifecycle behavior changes.
- Do not store real credentials, customer data, HR records, contracts, or
  confidential supplier documents in this repository.
- Link external operator evidence by neutral record identifier, not by secret or
  private URL.
- Every quarterly review must update [Review Sign-Off](./review-signoff.md).
