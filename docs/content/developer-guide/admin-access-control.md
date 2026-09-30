---
title: Admin Access Control
description: Admin RBAC role bundles, session claims, and ISO/IEC 27001:2022 access-review evidence.
sidebar_position: 9
---

# Admin Access Control

HybridClaw admin access has two compatibility modes:

- Legacy bearer tokens (`WEB_API_TOKEN` and `GATEWAY_API_TOKEN`) are treated as
  broad admin credentials.
- HybridAI-launched sessions without RBAC claims are treated as full admin
  sessions for compatibility.
- Scoped admin sessions are restricted only when the signed session payload
  includes `actions`, `scope`, `role`, or `roles` claims.

Scoped gateway API tokens use the same action and role vocabulary. Operators
can create them from `hybridclaw token create` or `/admin/credentials?tab=api-tokens`; HybridClaw
shows the token value only once, stores a salted verifier, and keeps later
lists metadata-only.

A device such as the HybridClaw phone app can get its own token without
anyone typing a secret into it, using the OAuth device authorization grant
shape (RFC 8628):

1. The device calls `POST /api/device/code` with `{"client_name": "…"}` and
   shows the returned `user_code` (for example `bcdf-ghjk`).
2. An admin who may create tokens opens `verification_uri`
   (`/admin/credentials?tab=devices`), enters the code, checks the device name
   and source address, and approves or denies it.
3. The device polls `POST /api/device/token` with `{"device_code": "…"}`. It
   gets `authorization_pending`, `slow_down`, `access_denied` or
   `expired_token` as a 400 until it is approved, then
   `{"access_token": "hck_…", "token_type": "Bearer"}` exactly once.

Requests live in memory for ten minutes, at most 20 at a time, and a gateway
restart drops them. The token is minted when the device collects it, labelled
`Device: <client_name>`, audited like any created token, and limited to
`chat.send`, `agents.read` and `artifacts.read` (`GET /api/artifact`). Revoke it
under API tokens. The two device routes need no credentials; approving needs
`admin.tokens.create` from a session, never from an API token.

Browser admin surfaces prefer HttpOnly session cookies. If a bearer token must
be entered manually, the console stores it in `sessionStorage` for the current
browser tab only and deletes any legacy `localStorage` copy. Live admin event
streams do not put bearer tokens in query strings.

The route-level action catalog and role bundle source of truth is
[`src/security/admin-rbac.ts`](../../../src/security/admin-rbac.ts). An admin
route with no action mapping there is denied to scoped sessions and scoped API
tokens unless they hold the `*` wildcard, so every new admin route needs an
entry.

## Role Bundles

These bundles are least-privilege defaults for scoped admin sessions. Operators
can still issue narrower sessions by using explicit `actions` or `scope` claims.

| Role | Intended holder | Included capability groups | Excluded by default |
| --- | --- | --- | --- |
| `admin.viewer` | Read-only operator or auditor | Admin overview, statistics, logs, team, agents, models, sessions, email, scheduler, channels, MCP, config read, browser pool health, A2A, fleet, signal, email config fetch, audit, approvals, tools, plugins, output guard read, distill read, skills read, jobs read | Mutations, secrets, terminal streams, gateway lifecycle |
| `admin.operator` | Day-to-day runtime operator | `admin.viewer` plus tunnel reconnect, session deletion, scheduler writes/deletes, browser pool start, distill writes/deletes, job writes/deletes | Secrets, policy changes, config reload/write, terminal streams, gateway lifecycle |
| `admin.integrations_manager` | Integration owner | `admin.viewer` plus team/agent writes, model writes, channel/MCP writes and deletes, webhook target writes, A2A/fleet writes and deletes, signal writes | Secrets, policy changes, terminal streams, gateway lifecycle |
| `admin.config_manager` | Runtime configuration owner | `admin.viewer` plus config write/reload, model writes, channel/MCP writes and deletes, webhook target writes, email config fetch | Secrets, policy changes, terminal streams, gateway lifecycle |
| `admin.security_manager` | Security owner | `admin.viewer` plus runtime secret metadata/write/unset, policy writes/deletes, output guard writes/previews, skills write/unblock/upload | Terminal streams, gateway lifecycle |
| `admin.terminal_operator` | Break-glass runtime maintainer | Terminal start, stop, stream, overview read, jobs read | General admin mutations, secrets, policy, config |
| `admin.full` | Break-glass administrator | Entire admin action catalog | Nothing |

Connector credential changes are secret mutations. Saving the HybridAI API key
and starting a connector OAuth flow require `secret.overwrite`, and logging a
connector out requires `secret.unset`. Only `admin.security_manager` and
`admin.full` include them, or `admin:owner` and `admin:secret-manager` among
the [ISO role bundles](./iso27001/access-control-matrix.md). Viewing connector
status and running a connector test need only `admin.connectors.read`. The
console Connectors page shows Connect, Rotate key, Reconnect, and Disconnect
only to callers holding the matching action; other callers keep Test and, for
connected GitHub and Microsoft 365, the Manage link to HybridAI, which applies
its own permissions.

## Session Claim Examples

Role-based session:

```json
{
  "typ": "session",
  "actor": "admin@example.com",
  "roles": ["admin.config_manager"],
  "exp": 1780000000
}
```

Narrow action-based session:

```json
{
  "typ": "session",
  "actor": "auditor@example.com",
  "actions": ["admin.audit.read", "admin.approvals.read"],
  "exp": 1780000000
}
```

Wildcard scope session:

```json
{
  "typ": "session",
  "actor": "operator@example.com",
  "scope": "admin.jobs:* admin.scheduler:*",
  "exp": 1780000000
}
```

Unknown role names are ignored. They do not broaden access.

## Issuance Requirements

Before issuing a scoped admin session, record:

- Requester and human owner.
- Business reason and expected duration.
- Granted roles, explicit actions, or scopes.
- Token label and expiry, when issuing a scoped API token.
- Approver.
- Expiration time.
- Ticket or review record link.

Use explicit `actions` for one-off duties. Use a role only when the holder has a
recurring operational responsibility matching the bundle.

## Access Review Evidence

Access reviews should run at least quarterly and after personnel or role
changes. Record each review in the organization ISMS evidence store.

| Review period | Reviewer | Subject | Current grants | Evidence checked | Decision | Follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-Q3 | Security owner | admin@example.com | `admin.config_manager` | Ticket, session issue log, audit events | Keep | Re-review next quarter |
| 2026-Q3 | Security owner | contractor@example.com | `admin.terminal_operator` | Ticket closed, no active duty | Revoke | Remove session and record revocation |

Reviewers should verify:

- Each grant maps to a current role or explicit approved action.
- Expired sessions and stale bearer tokens are removed.
- Expired, stale, or overbroad scoped API tokens are revoked.
- `admin.full` and `admin.terminal_operator` grants have break-glass or
  time-bound justification.
- Secret and policy grants are held only by security owners.
- Review decisions link to audit events or token/session issuance records.
