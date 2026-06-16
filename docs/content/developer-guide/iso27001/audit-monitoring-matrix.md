---
title: Audit And Monitoring Matrix
description: Audit event, retention, alerting, and monitoring evidence map for HybridClaw.
sidebar_position: 8
---

# Audit And Monitoring Matrix

Review date: 2026-06-16.

| Event/source | Source location | Integrity control | Retention | Alerting | Status |
| --- | --- | --- | --- | --- | --- |
| Session wire log | `data/audit/<session>/wire.jsonl` | SHA-256 hash chain | Operator-defined | Operator-defined | Implemented locally |
| Approval decisions | SQLite `approvals`, audit events | Structured audit rows | Operator-defined | Recommended for denials/red approvals | Implemented locally |
| Secret metadata list/overwrite/unset | Admin secret handlers | Structured mutation audit | Operator-defined | Recommended for failures and overwrites | Implemented locally |
| Admin route access | Admin API + RBAC checks | HTTP status and selected audit records | Operator-defined | Needs privileged-action catalog | Partial |
| Gateway/runtime logs | Structured logger output | Host log controls | Operator-defined | Operator-defined | Partial |
| Dependency audit | GitHub Actions dependency workflow | CI logs | GitHub retention | GitHub notifications | Partial |
| Container/image provenance | Release workflow | SBOM/provenance when enabled | Registry/GitHub retention | Registry/GitHub notifications | Open |
| Off-host security sink | SIEM/WORM/object storage | External append-only control | Security retention policy | SIEM alerts | Open |

## Required Operating Evidence

- Quarterly sample of `hybridclaw audit verify <sessionId>` output.
- Privileged-action event catalog that maps admin mutations to audit records.
- Off-host retention configuration and restoration/export test.
- Alert rules for secret mutation failures, denied approvals, gateway restart,
  and audit verification failure.
- Incident linkage showing how audit evidence is preserved during response.
