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
`chat.send`, `agents.read`, `artifacts.read` (`GET /api/artifact`, and
`POST /api/artifact/checklist`, which ticks one `- [ ]` item of a Markdown
list in an agent workspace), `voice.session`, so the phone can also call the
agent, and `sign_ins.manage`, so it can save the website sign-ins the agent's
browser asks for (see [Website sign-ins](../getting-started/authentication.md#website-sign-ins)). With
`chat.send` it also reads the notifications of its own chats under
`/api/push/`, and fetches one reply the gateway stored there on its own, such
as a reminder, with `GET /api/chat/message?sessionId=…&id=…` (the id is the
last part of a `reminder` notification id). That route answers only for chats
the same token started and never returns user turns. In those chats it also
puts one emoji on a reply, or takes it off with `null`, with
`POST /api/chat/reaction` (`sessionId`, `messageId`, `emoji`, and the `userId`
of its chat turns); that runs no turn, and a 👍 or 👎 also rates the reply.
While a turn of its own runs, it adds to it with `POST /api/chat/steer`
(`sessionId`, `content`): `{ "accepted": true }` means the running turn shows
the text to the model at its next step and stores it as a user message;
`{ "accepted": false }` means nothing happened (no turn of its own runs there,
the turn is finishing, or the text is a `/` command), and the phone sends it
as a turn of its own afterwards. `chat.send` also covers
`POST /api/media/upload`, so a phone can send a photo or document with a
message: the file lands in the uploaded-media cache for a day, and the turn
names it in `media`. Chatting is not administration: a slash command such as
`/secret`, `/env` or `/config` sent with this token is refused (see
[Local-Only Slash Commands](#local-only-slash-commands)). Revoke the token
under API tokens. The two device routes need no credentials; approving needs
`admin.tokens.create` from a session, never from an API token.

A hosted gateway's owner skips the code. The hosting service, which holds the
gateway's auth secret, signs the owner's phone a one-time pass shaped like a
launch token with `"typ": "device-handoff"`, the owner as `sub`, a `jti` and a
short `exp`. The phone sends `POST /api/device/handoff` with
`{"handoff": "…", "client_name": "…"}` and gets
`{"access_token": "hck_…", "token_type": "Bearer"}`, or `invalid_grant` for a
bad, expired or already used pass. That token also holds `chat.history`
(`GET /api/history`), `openai.api`, so a phone without a language model of its
own can ask the agent's model a short question on the
[OpenAI-compatible API](../guides/openai-compatible-api.md) without an agent
turn, and the claim `"owner": true`: its notifications and chats
are the owner's, the same ones the master token reaches, so chats the hosting
service relayed before stay readable. A browser launch token is never accepted
as a pass, and a pass never opens the console.

A device signs out with `DELETE /api/device/token` and its own token as
`Authorization: Bearer hck_…`. That revokes the calling token and nothing else.

Browser admin surfaces prefer HttpOnly session cookies. If a bearer token must
be entered manually, the console stores it in `sessionStorage` for the current
browser tab only and deletes any legacy `localStorage` copy. Live admin event
streams do not put bearer tokens in query strings.

The route-level action catalog and role bundle source of truth is
[`src/security/admin-rbac.ts`](../../../src/security/admin-rbac.ts). An admin
route with no action mapping there is denied to scoped sessions and scoped API
tokens unless they hold the `*` wildcard, so every new admin route needs an
entry.

## Local-Only Slash Commands

Some slash commands read or change this machine's secrets, env, config or
memory, so they run only in a local TUI, CLI or web chat session. A web chat
turn can also arrive over `POST /api/chat` or `POST /api/command` with a scoped
credential: an API token (such as a paired phone's) or a session with role
claims. Such a caller also needs the action the matching admin route asks for.
The local operator (TUI, CLI, the master token, the local web session) carries
no claims and may run them all.

| Command | Action |
| --- | --- |
| `/secret list`, `/secret status`, `/secret route list` | `secret.list_metadata` |
| `/secret set`, `/secret route add` | `secret.overwrite` |
| `/secret unset`, `/secret route remove` | `secret.unset` |
| `/env ...` (values are plaintext) | `admin.config.write` |
| `/config`, `/config check`, `/config get` | `admin.config.read` |
| `/config set` | `admin.config.write` |
| `/config reload` | `admin.config.reload` |
| `/speech` (status) | `admin.config.read` |
| `/speech provider\|model\|voice` | `admin.config.write` |
| `/voice` (info) | `admin.config.read` |
| `/voice call` | `admin.channels.write` |
| `/plugin config\|enable\|disable` | `admin.config.write` |
| `/policy ...` | `admin.policy.write` |
| `/memory inspect\|query` | `admin.sessions.read` |
| `/auth status <provider>` | `admin.models.read` |
| `/skill unblock` | `admin.skills.unblock` |
| `/skill install\|setup\|upgrade\|uninstall\|rollback` | `admin.skills.write` |
| `/agent install <local path>` | `admin.agents.write` |

The gateway takes these actions from the verified credential, never from the
request body. A device token holds none of them.

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

## Developer system files

`GET /api/system/files?agentId=<id>&path=<relative>&offset=<number>` browses the
registered agent's home (workspace), resolved through its configured workspace
mapping. Omitting `agentId` selects `main`; unknown or archived agents fail closed.
The response is `{scope: "agent-home", agentId, path, entries, nextOffset}` with up
to 500 folder-first entries per page. Filtering happens before pagination.
`download=true` returns regular file bytes, limited to 25 MB, with the header
`X-HybridClaw-File-Scope: agent-home`. Paths are relative to the agent home.

Both listings and direct downloads exclude hidden paths, credentials/tokens/
passwords, keys and certificates, scratch/editor/backup files, caches,
dependencies and build output. Supported document, media and text/source types
are allowed; archives, databases, executables and unknown formats are excluded.
Symlinks and special files cannot be listed or opened. Every path component is
checked, so a direct request cannot enter an excluded folder. The API disables caching and rejects absolute paths and traversal.

The separate `system_files.read` action is granted to owner phone tokens and
full administrators, not chat-only paired devices or viewer roles. The action
allows browsing registered agents on that instance; it is not a per-agent ACL.
Existing tokens keep their original permissions; replace them to receive this
capability. Root access to runtime configuration and credentials is not provided.

Migration: phone clients must send the runtime agent ID and use home-relative
paths. Updated iOS clients require the scope marker and reject older, unscoped
runtimes rather than exposing runtime-root files. Deploy both changes together.

Boundary notes: extension/name filtering is not a content secret scanner;
credentials embedded in ordinary documents are not detected. Supported office
and media files are intentionally retained even though their encoding is binary.
Keep sensitive data out of working documents. Tests cover traversal, links,
excluded ancestors, direct downloads, custom homes and filtered pagination.

### Markdown editing and reset

`GET /api/system/files?agentId=<id>&path=<relative>&edit=true` opens a visible
UTF-8 `.md` or `.markdown` file, up to 1 MB. It returns `{scope: "agent-home",
agentId, path, content, revision, canReset}`. `revision` is the SHA-256 of the
file bytes. `canReset` is true only for root bootstrap files with a shipped
workspace template; nested or user-created Markdown files have no default.

`PUT` to the same path with `{content, revision}` saves Markdown. `POST` with
`{revision}` resets that file to the runtime's shipped template. Both require
`system_files.write`, separately from read access. New owner phone tokens receive
it; paired chat-only devices and viewer roles do not. Existing owner phones can
renew their handoff token. This action does not permit creating files, editing
other formats, or entering hidden/excluded paths.

Updates compare the revision, prepare a same-directory temporary file, revalidate
the path and revision, then atomically replace the original. A changed file
returns 409; missing files are not recreated. Reset without a default returns
422. Invalid text returns 415 and oversized content returns 413. The editor keeps
unsaved text on errors and requires confirmation before discarding edits or
resetting the stored file. This is optimistic conflict detection, not a lock
against other processes writing the workspace.

Deploy the runtime editor endpoints and write grant before the companion phone
update. Older runtimes remain usable for browsing but cannot save or reset files.
