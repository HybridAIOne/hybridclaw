---
title: R14 SSO + Per-User Identity — Design
description: Inbound SSO for the admin console and web chat — trusted-proxy header mode, generic OIDC verifier, IdP group→role mapping onto admin RBAC, per-user sessions, and per-agent ACLs. Design doc for roadmap #14 / issue #557.
---

> **Internal document.** Design doc for roadmap **R14 (SSO + RBAC)** — umbrella issue
> [HybridAIOne/hybridclaw#557](https://github.com/HybridAIOne/hybridclaw/issues/557),
> children #511–#517. Status: **Draft** (2026-07-10). Priority P1, "Now" slot on the
> enterprise-gap roadmap. Companion to the roadmap row 14 constraints: reuse the
> production OAuth patterns in `src/auth/`, do **not** re-implement auth-code/PKCE.

# R14 — SSO + per-user identity

Humans authenticate to HybridClaw's web surfaces (admin console, web chat, published
apps) through the operator's IdP; IdP groups map onto the **existing** admin RBAC role
vocabulary; every session carries a real per-user identity; agents gain a per-agent
access policy for human users. The trusted-proxy header mode ships in week one as the
cheap on-ramp (works today with oauth2-proxy / Pomerium / Authentik / Caddy in front of
the gateway); the built-in OIDC relying party follows. SAML is explicitly out of scope.

**Competitive context (2026-07 survey):** deer-flow ships a full OIDC RP + RBAC,
hermes-agent gates its dashboard behind pluggable OIDC, hiclaw has pluggable
OIDC/SAML identity sources, openclaw documents trusted-proxy delegation. We already
lead on the RBAC substrate (v0.28 scoped tokens + ~110-action catalog); what's missing
is the identity front door.

## Goals

1. **Inbound OIDC verifier** for the admin console and web chat — generic (Entra, Okta,
   Google, Keycloak, any spec-compliant issuer), discovery-based, JWKS-cached.
2. **Trusted-proxy header mode** (openclaw's pattern) — identity delegated to an
   authenticating reverse proxy; ships first.
3. **IdP group→role mapping** onto the existing `src/security/admin-rbac.ts` role and
   scope vocabulary — no parallel permission model.
4. **Per-user sessions** — web chat and console actions attributed to a canonical
   `username@authority` user instead of the shared `'web-user'` actor.
5. **Per-agent ACLs** (#516) — which roles/users/groups may see and talk to which agent,
   enforced via the F3 policy engine.
6. **Auth audit events** (#517) on the hash-chain audit log.

## Non-goals

- **SAML** (hiclaw parity) — the `IdentitySource` seam below keeps the door open; not v1.
- **SCIM provisioning / directory sync** — users exist as claims, not synced records.
- **Custom named roles** beyond the shipped bundles — mapping rules can already target
  raw action/scope strings; a versioned custom-role editor (#515's stretch goal) is a
  follow-up.
- **Replacing machine credentials** — `hck_` scoped API tokens, `GATEWAY_API_TOKEN`,
  and A2A delegation tokens are unchanged. SSO is for humans on web surfaces.
- **Outbound OAuth** (`src/auth/*-auth.ts`, MCP OAuth) — untouched.

## Current state (what we build on)

| Piece | Where | Status |
|---|---|---|
| Auth chokepoint — every admin/API request resolves to `ResolvedAuthContext { kind: 'master'\|'apiToken'\|'session'\|'localSession'\|'none', payload }` | `resolveAuthContext()` [`src/gateway/gateway-http-server.ts:2217`](../../../src/gateway/gateway-http-server.ts) | the one seam SSO plugs into |
| Signed session claims — HMAC-SHA256 cookie `hybridclaw_session`, 24 h, claims `actor/sub/email/userId/username` + `roles/role/actions/scope` + `appIds`; minted by `setSessionCookie()`; `/auth/callback` already exchanges an externally signed launch token for a session | [`src/gateway/auth-token.ts`](../../../src/gateway/auth-token.ts) | reuse as-is — SSO mints the same cookie |
| Admin RBAC — ~110 dotted actions, role bundles (`admin:owner`, `admin:operator`, `admin:auditor`, `admin:secret-manager`, `admin.viewer`, `admin.operator`, `admin.config_manager`, `admin.security_manager`, `admin.terminal_operator`, `admin.integrations_manager`, `admin.full`), wildcard scopes, route→action map, `isAdminActionAllowed()` | [`src/security/admin-rbac.ts`](../../../src/security/admin-rbac.ts) | #515's role model largely exists; mapping targets it |
| Inbound OIDC verifier — jose `jwtVerify` + `createRemoteJWKSet`, JWKS cache; **Entra-hardcoded** (issuer host, `tid`/`scp` claims) | [`src/gateway/msteams-tab.ts`](../../../src/gateway/msteams-tab.ts) | generalize; Teams tab becomes a consumer |
| Published apps — policy kinds `link`/`password`/`oidc`; `oidc` rejects any provider ≠ `entra`; browser fallback uses the **deprecated implicit flow** (`response_type=token`); success mints a scoped `hck_` viewToken with `viewer` claims | [`src/security/app-publications.ts`](../../../src/security/app-publications.ts), `gateway-http-server.ts` §pub | generalize provider; migrate implicit → code+PKCE |
| OIDC/OAuth discovery (RFC 8414 + `openid-configuration`), auth-code+PKCE client, RFC 8707/9728/7591 | [`src/mcp/mcp-oauth.ts`](../../../src/mcp/mcp-oauth.ts) | reuse discovery shape (extend to read `jwks_uri`, `issuer`, `end_session_endpoint`) |
| Canonical user identity — `username@authority` (F7.1, reserved authorities `hybridai`, `local`), polymorphic `Actor` (F7.5) | [`src/identity/user-id.ts`](../../../src/identity/user-id.ts), [`src/identity/actor.ts`](../../../src/identity/actor.ts) | SSO users get a provider authority |
| Web chat identity — chat requests carry `req.userId` but fall back to the shared literal `'web-user'` | [`src/gateway/gateway-chat-service.ts:892`](../../../src/gateway/gateway-chat-service.ts) | per-user sessions fill this in |
| Session keying — `agent:<id>:channel:<kind>:chat:<type>:peer:<peerId>`; `sessionRouting.dmScope: 'per-linked-identity'` + `identityLinks` merge one human's DMs across channels | [`src/session/session-key.ts`](../../../src/session/session-key.ts), [`src/session/session-routing.ts`](../../../src/session/session-routing.ts) | SSO identity becomes the natural `identityLinks` key |
| Access control on chat surfaces — **per-channel** `dmPolicy`/`allowFrom` only; no per-agent ACL; `AgentConfig` has `ownerUserId`, org chart, `a2a.exposure` (agent-to-agent only) | [`src/config/runtime-config.ts`](../../../src/config/runtime-config.ts), [`src/agents/agent-types.ts`](../../../src/agents/agent-types.ts) | #516 adds `access` here |
| F3 policy engine (predicate → action), F4 versioned config | #416 ✅, #417 ✅ | dependencies satisfied |

**Known prerequisite (roadmap "Sequencing risks"):** F7.1 shipped the canonical user-id
format, but channel dispatch still routes off channel-native peer ids —
`formatLocalOwnerUserId()` is only applied at audit/board time. A small **F7.x
(user-id propagation through channel dispatch)** must land with PR4 below, or per-agent
ACLs and R5 budgets ship channel-keyed and need a refactor.

## Design overview

Three auth modes for web surfaces, all funneling into the **same** session claims and
the **same** RBAC — SSO adds front doors, not a parallel permission system:

| Mode | Who verifies identity | Config | Notes |
|---|---|---|---|
| `local` (today) | nobody / bearer token / HybridAI launch token | none (default) | unchanged; loopback console keeps working with zero config |
| `trusted-proxy` | reverse proxy (oauth2-proxy, Pomerium, Authentik, Caddy…) | `sso.trustedProxy` | week-one on-ramp; any IdP the proxy supports, including SAML-behind-proxy |
| `oidc` | HybridClaw as OIDC relying party | `sso.oidc.providers[]` | auth-code + PKCE; Entra/Okta/Google presets |

The pipeline for both SSO modes:

```
proxy headers ──┐
                ├─→ ExternalIdentity ─→ guards ─→ group→role mapping ─→ session claims ─→ existing RBAC / ACL
verified OIDC ──┘   {username, email,    (domain,   (sso.mapping)        {sub, userId,      (admin-rbac.ts,
    id_token         name, groups[],      verified,                        email, roles,      F3 agent.access)
                     rawClaims, idp}      allowUsers)                      idp, authTime}
```

### 1. Shared identity + mapping layer (new `src/security/sso-identity.ts`)

Both modes produce one normalized shape before any authorization decision:

```ts
interface ExternalIdentity {
  idp: string;              // provider id ('proxy' for trusted-proxy, else sso.oidc.providers[].id)
  subject: string;          // OIDC sub / proxy user header value
  email?: string;
  emailVerified?: boolean;
  name?: string;
  groups: string[];         // groups claim / groups header (comma- or JSON-array-parsed)
  rawClaims: Record<string, unknown>;
}
```

**Canonical user id.** `userId = <slug(email local-part || subject)>@<authority>` where
`authority` is the provider's configured authority slug (default: provider id). The
component charset already fits [`user-id.ts`](../../../src/identity/user-id.ts)
(`[a-z0-9._-]`, 2–128 chars); `hybridai` and `local` stay reserved and are rejected as
SSO authorities. Collision rule: two IdP subjects that slug to the same username within
one authority are disambiguated by a stable `sub`-hash suffix (hiclaw's rendezvous-hash
trick), and the full `iss`+`sub` pair is always kept in the session claims — the
canonical id is for attribution and ACLs, not for verification.

**Group→role mapping** (`sso.mapping`, shared by both modes):

1. Provider guards run first: `allowedDomains`, `requireVerifiedEmail`, `allowUsers`
   (exact email/subject allowlist; empty = any authenticated user passes to mapping).
2. Rules are evaluated top-down; **all** matching rules contribute (union), so ordering
   never silently drops a grant. A rule matches on `groups` / `emails` / `domains` /
   `claims` (arbitrary claim equality) and grants `roles` and/or raw `scopes`.
3. `defaultRoles` are added for any authenticated user.
4. **Fail closed:** if the resulting role+scope set is empty and `denyUnmapped: true`
   (default), the login is refused with `auth.login_denied` (reason `no_role_mapping`).
5. Role names are validated against the `admin-rbac.ts` vocabulary at config load;
   unknown names are a `doctor` error, not a silent no-grant.

**Load-bearing invariant:** `collectAdminActionClaims()` treats a payload with *no*
RBAC claims as full admin (v0.28 back-compat for HybridAI-minted sessions). SSO-minted
sessions must therefore **always** carry a non-empty `roles`/`actions` claim — the
mapping layer enforces this structurally (step 4), and a regression test pins it. An
SSO login can never fall into the unscoped-full-admin branch.

This beats deer-flow's mapping (email-list → admin/user only) and matches what Entra,
Okta, and Keycloak operators actually configure: group DN/name → role.

### 2. Trusted-proxy header mode — week one

OpenClaw's pattern (see their `docs/gateway/trusted-proxy-auth.md`), adapted to our
config vocabulary. The proxy terminates the IdP handshake and asserts identity via
headers; the gateway trusts those headers **only** after an ordered, fail-closed check
chain:

1. Socket source IP ∈ `trustedProxies` (CIDR-aware) — else reject
   (`trusted_proxy_untrusted_source`).
2. Loopback sources are rejected unless `allowLoopback: true` **and** loopback is
   listed in `trustedProxies` (same-host proxy is opt-in twice).
3. A non-loopback source matching one of the gateway host's own interface addresses is
   rejected (spoof guard); if interface discovery fails, fail closed.
4. `userHeader` plus every `requiredHeaders` entry present and non-blank — else reject.
   Recommend `requiredHeaders` carry the proxy's own proof header where available
   (e.g. `x-pomerium-jwt-assertion`).
5. `allowUsers` (if non-empty) must contain the extracted user.
6. Identity → mapping layer (§1) → request-scoped auth context. Groups come from
   `groupsHeader` when configured.

Every rejection gets a stable reason code (`trusted_proxy_*`) surfaced in logs and
`auth.login_denied` audit events — openclaw's diagnosability is worth copying wholesale.

**Interplay with existing credentials when SSO is enabled** (either mode):

- `WEB_API_TOKEN` master bearer is **refused from non-loopback sources** unless
  `sso.allowTokenFallback: true` (default `false`) — otherwise a leaked static token
  bypasses the IdP. Unlike openclaw we don't hard-reject the combination at startup:
  loopback keeps accepting it (CLI/dev ergonomics), and `doctor` warns when it's
  configured but unusable.
- `hck_` scoped API tokens remain valid everywhere — they are revocable, explicitly
  scoped machine credentials, which is exactly what automation should use.
- `GATEWAY_API_TOKEN` (internal/loopback) and the HybridAI launch-token `/auth/callback`
  are unchanged.
- Session TTL for SSO-minted sessions: `sso.sessionTtlSeconds`, default 12 h
  (≤ the existing 24 h cap). Re-auth is a cheap IdP redirect (silent when the IdP
  session is alive). No refresh tokens in v1.

Trusted-proxy sessions can be stateless (identity re-asserted per request by the proxy)
— no cookie needed; the gateway builds the auth context per request. That is what makes
this shippable in week one: no login UI, no callback endpoint, no state handling.

**Documentation must include** the proxy-side checklist: the proxy MUST strip/overwrite
inbound `x-forwarded-user` / `x-forwarded-groups` / `Forwarded` headers from clients,
and the gateway port must not be reachable except via the proxy (bind `127.0.0.1` or
firewall). `hybridclaw doctor` flags: trusted-proxy enabled with empty `trustedProxies`
(error), empty `allowUsers` + `denyUnmapped: false` (warn), gateway bound to a
non-loopback host without the port-restriction note acknowledged (warn).

### 3. Generic inbound OIDC verifier + provider registry

**Verifier** (new `src/security/inbound-oidc.ts`): extract the working core of
`msteams-tab.ts` and make it issuer-generic —

- Discovery via `{issuer}/.well-known/openid-configuration` (reuse the
  `mcp-oauth.ts` discovery shape; extend it to read `issuer`, `jwks_uri`,
  `end_session_endpoint`). Manual endpoint overrides per provider for non-discovering
  IdPs.
- `createRemoteJWKSet` cached per issuer (today's cache is keyed by Entra tenant).
- ID-token verification rules: `alg` allowlist **RS256/ES256/PS256 families — HS256 and
  `none` rejected** (hermes's rule; prevents alg-confusion against the shared HMAC
  secret); `iss` exact-match pinned to the configured issuer (RFC 8414 rule, deer-flow);
  `aud` must contain `clientId` (+ `azp` check when multiple audiences);
  `exp`/`iat`/`nbf` with `clockToleranceSeconds` (default 60 — the current verifier's
  0 s tolerance is a known operational footgun); `nonce` must match the login state.
  Optional userinfo fetch cross-checks `sub` (deer-flow).
- IdP-unreachable (JWKS/discovery down) is **503, distinct from 401 invalid** — a
  transient IdP outage must not read as "bad credentials" (hermes's
  unreachable-vs-invalid distinction).

**Provider registry** (#511's `IdentityProvider` seam): providers are config entries
resolved by a small registry keyed by provider **id**, with vendor **presets** filling
defaults (issuer template, claim names, quirks). The registry interface is deliberately
protocol-shaped (hiclaw's lesson: key by protocol abstraction, not vendor name) so a
future SAML source slots in without touching consumers:

| Preset | Issuer shape | Groups | Quirks handled |
|---|---|---|---|
| `entra` (#514) | `https://login.microsoftonline.com/<tenant>/v2.0` | `groups` claim (GUIDs) or app roles | **groups overage**: >200 groups → claim omitted with `_claim_names` indirection — surface a doctor-visible login error recommending app-role mapping instead of silently granting nothing |
| `okta` (#512) | `https://<org>.okta.com` (or custom auth server) | `groups` claim (needs claim config on the authorization server — documented) | — |
| `google` (#513) | `https://accounts.google.com` | **id_tokens carry no groups** — v1 maps on `hd` (domain) + email rules; Directory-API group fetch is a follow-up | `email_verified` enforced |
| generic | any spec-compliant issuer (Keycloak, Authentik, Zitadel…) | configurable `groupsClaim` | reference implementation per #511 |

`msteams-tab.ts` is refactored to consume the generic verifier (Entra preset +
`tid`/`scp` post-checks stay as Teams-specific wrapper logic) — **no behavior change**,
existing tests keep passing.

### 4. Console + web chat login flow

New gateway endpoints (all on the existing HTTP server, no new listener):

- `GET /auth/sso/providers` — public; lists `{id, label}` for the login screen.
- `GET /auth/sso/<provider>/login?next=…` — builds the authorization URL with
  **auth-code + PKCE (S256)** + `state` + `nonce`; stashes
  `{state, nonce, codeVerifier, next}` in a **stateless signed HttpOnly cookie**
  (deer-flow's pattern: HMAC-signed with the existing auth secret, 5-min TTL,
  `SameSite=Lax`, path-scoped to the callback). No server-side state store, so it
  survives restarts and multi-worker setups. PKCE/state/loopback-redirect mechanics
  copy `google-auth.ts` / `codex-auth.ts` — per the roadmap constraint, we do not
  re-implement them from scratch, we lift them.
- `GET /auth/sso/<provider>/callback` — constant-time `state` compare, code exchange,
  ID-token verification (§3), mapping (§1), then **`setSessionCookie()`** with the
  mapped claims — the exact cookie the console already understands. `next` is
  open-redirect-guarded (same guard `/auth/callback` uses today).
- `POST /auth/logout` — clears the session cookie, emits `auth.logout`; when discovery
  exposed `end_session_endpoint`, responds with the RP-initiated-logout URL for the
  console to redirect to.

Session claims minted for SSO logins:

```jsonc
{
  "typ": "session",
  "sub": "<oidc sub>",           "userId": "lena@entra",     // canonical, per §1
  "email": "lena@acme.com",      "username": "lena",
  "name": "Lena Example",        "idp": "entra",
  "roles": ["admin:operator"],   "scope": "chat.send",       // mapping output — never empty
  "sid": "<IdP session id if present>",                      // stored for future backchannel logout
  "authTime": 1783948123,        "iat": …, "exp": …
}
```

**Console changes** (`console/src/auth.tsx`, `login-screen.tsx`): when
`/auth/sso/providers` is non-empty, the login screen shows "Sign in with <label>"
buttons (auto-redirect when exactly one provider and token fallback is off — hermes's
auto-SSO with a one-shot loop-guard). The token-paste field remains only when
`sso.allowTokenFallback: true` or on loopback. API 401s keep returning JSON (never a
302 into the IdP — SPA fetches must not follow cross-origin redirects; hermes splits
HTML-302 vs API-401 and so do we, which the console's existing `AUTH_REQUIRED_EVENT`
handling already expects).

**Published apps / Teams tab:** the publication `oidc` policy drops its
`provider === 'entra'` restriction and takes any configured provider id; the browser
fallback's **implicit flow is replaced** by the same code+PKCE endpoints (the
`/pub-oidc-callback` implicit handler is removed — per repo policy, no compatibility
shim for the unreleased-surface flow). Teams-tab SSO (`getAuthToken`) is untouched.

### 5. Per-user sessions + attribution

With identity in the session cookie:

- **Web chat actor**: `/api/chat*` handlers thread the session's canonical `userId`
  into `GatewayChatService` requests, replacing the `'web-user'` fallback at
  [`gateway-chat-service.ts:892`](../../../src/gateway/gateway-chat-service.ts).
  Ratings (`response-ratings.ts`), board attribution, and audit records then key on the
  real human via the existing `Actor` plumbing.
- **Per-user web sessions**: web-chat session keys derive their `peer` segment from the
  canonical user id, so each authenticated human gets their own thread history instead
  of one shared web session. Anonymous/loopback behavior is unchanged.
- **Cross-channel linking**: `sessionRouting.identityLinks` is documented (and
  console-surfaced later) with canonical SSO ids as the logical key —
  `"lena@entra": ["whatsapp:+49171…", "telegram:12345"]` — so `per-linked-identity`
  DM scope merges a human's web chat with their channel DMs, and per-agent ACLs (§6)
  become enforceable for linked channel peers immediately.
- **F7.x prerequisite**: propagate the canonical user id through channel-runtime
  inbound dispatch (today raw peer ids only; `formatLocalOwnerUserId()` is applied at
  audit time). Filed as its own small issue and landed with PR4 — this is the shared
  substrate R5 budget enforcement also needs, per the roadmap sequencing note.

### 6. Per-agent ACLs (#516)

New optional block on `AgentConfig` (validated in `normalizeAgentsConfig`,
F4-versioned like the rest of runtime config):

```jsonc
{
  "agents": {
    "list": [
      { "id": "main" },                                    // no block = open (default, back-compat)
      { "id": "finance-coworker",
        "access": {
          "visibility": "restricted",
          "allowUsers": ["lena@entra", "ben@okta"],        // canonical ids or emails
          "allowRoles": ["admin:operator"],                // admin-rbac role names
          "allowGroups": ["Finance-Team"]                  // raw IdP groups (pre-mapping)
        } }
    ]
  }
}
```

Compiled at config load into an **F3 policy predicate** (`agent.access`) — #516's
acceptance criterion — and evaluated wherever a human actor and a target agent meet:

1. **Chat dispatch** (`gateway-chat-service`, including `@handle` addressing): denied
   agents respond with a uniform refusal; the attempt emits `agent.access_denied`.
2. **Agent listing** (`/api/agents`, console picker): `restricted` agents the viewer
   cannot access are filtered out, not greyed out.
3. **Published-app session mint**: the app's bound agent is checked against the OIDC
   `viewer` before a viewToken is issued.
4. **Channel inbound**: enforced when the channel peer resolves to a canonical user via
   `identityLinks` (or, post-F7.x, the propagated user id). Unlinked channel peers stay
   governed by the existing per-channel `dmPolicy`/`allowFrom` — the ACL never *widens*
   channel access, it only narrows it.

**Boundary:** admin RBAC keeps governing admin routes (config, secrets, tokens); the
agent ACL governs *who may see and talk to an agent*. An `admin:owner` bypasses agent
ACLs (parity with today's unscoped-admin behavior); everyone else — including
`admin.viewer` holders — is subject to them.

## Config schema (consolidated)

New top-level `sso` block (camelCase, `secret://` refs supported for secrets — same
registration mechanism as `ops.webApiToken`):

```jsonc
{
  "sso": {
    "sessionTtlSeconds": 43200,
    "allowTokenFallback": false,
    "mapping": {
      "denyUnmapped": true,
      "defaultRoles": [],
      "rules": [
        { "match": { "groups": ["HC-Admins"] },   "roles": ["admin:owner"] },
        { "match": { "groups": ["HC-Ops"] },      "roles": ["admin:operator"] },
        { "match": { "domains": ["acme.com"] },   "roles": ["admin.viewer"], "scopes": ["chat.send"] }
      ]
    },
    "trustedProxy": {
      "enabled": false,
      "trustedProxies": ["10.0.0.0/8"],
      "userHeader": "x-forwarded-user",
      "emailHeader": "x-forwarded-email",
      "groupsHeader": "x-forwarded-groups",
      "requiredHeaders": [],
      "allowUsers": [],
      "allowLoopback": false,
      "authority": "proxy"
    },
    "oidc": {
      "enabled": false,
      "providers": [
        {
          "id": "entra",                       // registry key; default authority slug
          "preset": "entra",                   // entra | okta | google | generic
          "label": "Acme Entra ID",
          "issuer": "https://login.microsoftonline.com/<tenant>/v2.0",
          "clientId": "…",
          "clientSecret": "secret://sso/entra-client-secret",   // omit for public client + PKCE
          "scopes": ["openid", "profile", "email"],
          "groupsClaim": "groups",
          "usernameClaim": "preferred_username",
          "allowedDomains": ["acme.com"],
          "requireVerifiedEmail": true,
          "clockToleranceSeconds": 60
        }
      ]
    }
  }
}
```

## Security considerations

1. **Header spoofing** (trusted-proxy): mitigated by the ordered source checks (§2) and
   the documented strip-headers proxy requirement. Forwarded-header evidence on a
   loopback request additionally disqualifies the local-session fallback (openclaw's
   guard — a request that *claims* to be proxied never gets loopback trust).
2. **Alg confusion**: HS256 rejected for id_tokens; the shared HMAC secret signs only
   our own session/launch tokens, never verifies IdP material.
3. **Audience confusion**: `aud` pinned to `clientId` per provider; publication OIDC
   keeps its per-publication audience.
4. **Replay / CSRF on login**: single-use `state` (constant-time compare) + `nonce`
   bound in the signed state cookie; PKCE S256 binds the code to this login. Session
   cookie stays `HttpOnly` + `SameSite=Lax`; state cookie is path-scoped to the
   callback.
5. **Open redirect**: `next` targets pass the existing `/auth/callback` guard
   (same-origin path only).
6. **Session fixation**: the session cookie is always re-minted at callback time; the
   state cookie is cleared.
7. **Downgrade**: enabling SSO turns off `WEB_API_TOKEN` for non-loopback sources by
   default (§2); `doctor` + the security-audit surface flag every weakening knob
   (`allowTokenFallback`, `allowLoopback`, empty `allowUsers`, `denyUnmapped: false`) —
   openclaw treats trusted-proxy misconfig as a critical audit finding and so should we.
8. **Unscoped-claims back-compat**: structurally unreachable for SSO sessions (§1
   invariant + regression test).
9. **IdP outage**: 503 with retry semantics, never 401; JWKS cache (jose cooldown)
   keeps verifying briefly through blips; trusted-proxy mode is unaffected (the proxy
   holds the IdP relationship).
10. **Fleet**: session cookies are per-instance (shared `HYBRIDCLAW_AUTH_SECRET`
    deployments excepted); cross-instance SSO is out of scope here and tracked with the
    A2A/fleet work.

## Audit events (#517)

New hash-chained event types in `src/audit/`: `auth.login` (mode, idp, userId, roles,
source ip), `auth.login_denied` (reason code — `trusted_proxy_*`, `oidc_*`,
`no_role_mapping`, …), `auth.logout`, `agent.access_denied` (actor, agent, surface).
Existing `token.created`/`token.revoked` unchanged. Verified by JSONL inspection in
tests, per the issue's acceptance criteria.

## Rollout — PR phasing

| PR | Scope | Issues | Notes |
|---|---|---|---|
| **PR1 — week one** | Trusted-proxy mode: `sso.trustedProxy` + `sso.mapping` config, `ExternalIdentity` + mapping layer (`sso-identity.ts`), `resolveAuthContext` branch, reason codes, `auth.*` audit events, doctor checks, operator guide (oauth2-proxy + Caddy recipes) | #515 (mapping onto existing roles), #517, part of #511 | No UI work; ships SSO-behind-proxy for every IdP incl. SAML-capable proxies |
| **PR2** | Generic inbound OIDC verifier + discovery + JWKS cache (`inbound-oidc.ts`); provider registry + presets; refactor `msteams-tab.ts` onto it (behavior-neutral, tests green) | #511, #514 (verifier half) | Pure library + refactor; no new endpoints |
| **PR3** | Console login: `/auth/sso/*` endpoints (code+PKCE, signed state cookie), session mint via `setSessionCookie`, logout, login-screen SSO buttons, `allowTokenFallback` enforcement | #511 done, #512, #513, #514 done | Presets are config + docs once PR2's registry exists |
| **PR4** | Per-user sessions: thread canonical userId into chat/ratings/audit, per-user web session keying, `identityLinks` on canonical ids; **F7.x user-id propagation through channel dispatch** (filed separately, landed here) | new F7.x | Unblocks R5 per-user budgets too |
| **PR5** | Per-agent ACLs: `agents.list[].access`, F3 `agent.access` predicate, enforcement at chat dispatch / agent listing / publication mint / linked channel peers, console surfacing | #516 | Depends on PR4's identity propagation |
| **PR6** | Published-app OIDC generalization: any provider, implicit→code+PKCE migration (remove `/pub-oidc-callback` implicit handler), security-audit checks, `admin-access-control.md` + configuration reference updates | #514 completion, hardening | Closes out #557 |

## Testing

- **Unit**: mapping matrix (guards, rule union, deny-unmapped, unknown-role rejection);
  verifier against an injected JWKS (the `options.jwks` test seam `msteams-tab` already
  uses) covering alg/iss/aud/exp/nonce/skew; trusted-proxy check ordering — each of the
  six checks fails closed independently.
- **Integration** (`tests/gateway-http-server.test.ts` pattern): auth-kind precedence
  with SSO enabled (proxy headers vs bearer vs cookie vs loopback), 401-JSON vs
  302-HTML split, callback → cookie → RBAC-enforced route end-to-end.
- **Regression**: existing unscoped-session back-compat unchanged when `sso` is absent;
  SSO session never yields `collectAdminActionClaims() === null`; msteams-tab suite
  unchanged after the PR2 refactor.
- **Manual/e2e recipe**: Keycloak in docker + oauth2-proxy compose file under
  `docs/content/guides/` — doubles as the operator guide fixture (and the R25 EU-stack
  story: Keycloak self-hosted next to HybridClaw).

## Docs to update

`docs/content/developer-guide/admin-access-control.md` (new modes + claim examples),
`docs/content/reference/configuration.md` (`sso` block), new
`docs/content/guides/sso.md` (proxy recipes, IdP setup per preset, groups-overage note),
`config.example.json`.

## Open questions

1. **Refresh + backchannel logout** — v1 has fixed-TTL sessions and stores `sid`;
   OIDC `frontchannel/backchannel_logout` and refresh-token session extension are v2.
   Decide before enterprise pilots whether 12 h fixed is acceptable.
2. **Session inventory/revocation** — "list active sessions, revoke one" needs a
   server-side session record (today's cookies are stateless). Ties into R12 mobile
   admin; propose deferring until a design exists for stateful sessions.
3. **Google Workspace groups** — Directory API fetch (needs domain-wide delegation) vs
   staying on domain/email rules; revisit after first Google-shop customer.
4. **Custom named roles** (#515 stretch) — mapping to raw scopes covers v1; a
   role-editor with F4 versioning is a follow-up row.
5. **Trusted-proxy + OIDC simultaneously** — allowed by config shape (different
   sources), but do we want doctor to warn? Leaning yes (two identity front doors is
   usually a misconfig).

## Appendix — reference implementations surveyed (2026-07)

- **openclaw** `docs/gateway/trusted-proxy-auth.md`, `src/gateway/auth.ts`
  (`authorizeTrustedProxy`), `src/gateway/net.ts` — config keys
  (`gateway.trustedProxies`, `auth.trustedProxy.{userHeader,requiredHeaders,allowUsers,allowLoopback}`),
  ordered fail-closed checks, reason-code taxonomy, token/proxy mutual exclusion,
  security-audit critical findings. Header vocabulary: `x-forwarded-user`,
  `x-pomerium-claim-email` + `x-pomerium-jwt-assertion`, `x-auth-request-email`.
- **deer-flow** `backend/app/gateway/auth/{oidc,oidc_state,user_provisioning}.py`,
  `authz.py` — full hand-rolled OIDC RP (httpx + PyJWT): stateless signed-cookie state,
  issuer pinning, no auto-account-linking (409 on email collision), userinfo `sub`
  cross-check, own-JWT session + CSRF double-submit. Weakness we exceed: role mapping
  is `admin_emails` list only; RBAC table is scaffold (all-permissions + owner checks).
- **hiclaw** `hiclaw-controller/internal/controller/humanidentity/` — `IdentitySource`
  registry keyed by protocol (`external_sso`, `legacy_password`), spec-driven source
  selection, `sha256(issuer + \0 + subject)` deterministic identity derivation,
  `ManagesInitialPassword()` double-gate.
- **hermes-agent** `hermes_cli/dashboard_auth/` — bind-derived auth requirement,
  provider stacking with unreachable-vs-invalid (503 vs 401) distinction, HTML-302 vs
  API-401 split, ID-token-only verification with HS256 excluded, reverse-proxy prefix
  awareness, auto-SSO with loop guard.
