---
title: Access-Control Matrix
description: Admin RBAC, token/session handling, and access-review evidence for HybridClaw.
sidebar_position: 5
---

# Access-Control Matrix

Review date: 2026-06-16.

## Admin Role Bundles

Role bundles are implemented in `src/security/admin-rbac.ts`.

| Role claim | Intended assignee | Permission summary | Review cadence |
| --- | --- | --- | --- |
| `admin:owner` | Primary system owner | Full admin action catalog, including secrets and gateway restart/shutdown. | Monthly |
| `admin:operator` | Runtime operator | Read access plus operational writes, excluding secret overwrite/unset and gateway shutdown. | Quarterly |
| `admin:auditor` | Auditor/compliance reviewer | Read-only admin, audit, logs, metadata, and secret metadata. | Quarterly |
| `admin:secret-manager` | Credential custodian | Secret metadata, overwrite, and unset actions only. | Monthly |

## Token And Session Handling

| Surface | Authentication | Storage | Notes |
| --- | --- | --- | --- |
| Local loopback console | HttpOnly `hybridclaw_local_session` cookie | Browser cookie, `SameSite=Strict` | Issued only to loopback requests without forwarding headers. |
| HybridAI-launched console | HttpOnly `hybridclaw_session` cookie | Browser cookie, `SameSite=Lax` | Signed session payload can carry action or role claims. |
| Manual `WEB_API_TOKEN` entry | Bearer header from in-memory React state | Not persisted in browser storage | Reloading the page requires re-entry. |
| `/api/events` SSE | Bearer header or cookie auth at request boundary | No query-token auth | Browser EventSource uses same-origin cookies. |
| Artifact compatibility links | Bearer or query token | URL token for compatibility | Separate from admin SSE; review before external sharing. |

## Access Review Procedure

1. Export or list active admin subjects, role claims, and explicit action claims.
2. Confirm each subject has a named owner and business need.
3. Remove stale or overbroad roles, especially `admin:owner` and
   `admin:secret-manager`.
4. Record reviewer, date, sampled evidence, exceptions, and remediation due date
   in [Review Sign-Off](./review-signoff.md).

## Initial Access Review Record

| Date | Reviewer | Scope | Result | Follow-up |
| --- | --- | --- | --- | --- |
| 2026-06-16 | Engineering | Repo-visible RBAC model | Role bundles and route-level actions exist in code. | Operator must attach real user/session inventory before audit. |
