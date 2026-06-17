---
title: Risk Register
description: Initial ISMS risk register for HybridClaw.
sidebar_position: 3
---

# Risk Register

Review date: 2026-06-17.

Scoring uses `Low`, `Medium`, and `High` until the operator adopts a formal
likelihood/impact scale.

| ID | Risk | Assets | Existing controls | Rating | Treatment | Owner | Due | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R-001 | Missing ISMS operating records could block audit readiness. | ISMS records, product security docs | This evidence package and control matrix | High | Maintain SoA, risk register, owner table, evidence calendar, and sign-off records. | ISMS Owner | 2026-06-30 | In progress |
| R-002 | Overbroad admin access could allow unauthorized privileged changes. | Admin API, runtime config, secrets metadata | Route-level RBAC, role bundles, session claims | High | Use named roles, review access quarterly, revoke stale sessions/tokens. | Access Owner | 2026-06-30 | In progress |
| R-003 | Browser-readable admin tokens could be stolen through XSS. | Admin console, `WEB_API_TOKEN` | HttpOnly cookies for local/session auth, no token localStorage, no SSE query tokens, CSP | Medium | Keep manual token entry memory-only and prefer signed sessions. | Access Owner | 2026-06-16 | Treated in repo |
| R-004 | Local audit logs could be deleted or altered by host compromise. | Audit wire logs, SQLite audit tables | Hash chaining, verify command | High | Add off-host/WORM export and alerting. | Audit Owner | 2026-07-15 | Open |
| R-005 | Data retention/deletion obligations could be missed. | Session transcripts, memory DB, uploaded media | Trust model assigns operator responsibility | High | Define retention schedule and deletion workflow with tests. | Data Owner | 2026-07-15 | Open |
| R-006 | Supplier or model-provider terms may not match data handling needs. | Provider APIs, channel providers, registries | Supplier register created | Medium | Complete DPA/security review and exit plan per supplier. | Supplier Owner | 2026-07-31 | Open |
| R-007 | Container or package supply-chain compromise could affect runtime integrity. | npm packages, Docker image, GHCR | npm lockfiles, release-age policy, audit signatures, image SBOM/provenance, CodeQL SAST, tracked secret scan | Medium | Define vulnerability SLAs, remediation tracking, exception handling, and release security sign-off. | Engineering Owner | 2026-07-15 | In progress |
| R-008 | Incident response may be slow without exercised roles and contact paths. | Gateway runtime, data stores, credentials | SECURITY incident steps | Medium | Run tabletop, record severity matrix, contacts, and post-incident template. | Incident Owner | 2026-07-31 | Open |
| R-009 | Secret-store master key loss or disclosure could affect credential access. | Runtime secret store | AES-256-GCM, local permission controls | High | Define key custody, rotation, recovery, and break-glass process. | Security Owner | 2026-07-15 | Open |
| R-010 | Insufficient monitoring could delay abuse or capacity detection. | Gateway API, containers, channels | Request-size limits, resource constraints | Medium | Define rate limits, metrics, thresholds, and alert response. | Operations Owner | 2026-07-31 | Open |
