---
name: miro
description: "Discover Miro boards, read board items for planning and summaries, prepare guarded board writes, and run Enterprise board export workflows through SecretRef-backed API requests."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: miro-access-token
    kind: bearer
    required: true
    secret_ref:
      source: store
      id: MIRO_ACCESS_TOKEN
    scope: "api.miro.com/v2 boards:read boards:write"
    how_to_obtain: "Create a Miro OAuth app or access token with the narrowest needed board scopes. Set `MIRO_ACCESS_TOKEN` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set MIRO_ACCESS_TOKEN \"<token>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set MIRO_ACCESS_TOKEN \"<token>\"`."
  - id: miro-discovery-access-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: MIRO_DISCOVERY_ACCESS_TOKEN
    scope: "api.miro.com/v2 boards:export"
    how_to_obtain: "Enterprise admins can enable eDiscovery in Miro Enterprise Integrations. Set `MIRO_DISCOVERY_ACCESS_TOKEN` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set MIRO_DISCOVERY_ACCESS_TOKEN \"<token>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set MIRO_DISCOVERY_ACCESS_TOKEN \"<token>\"`."
  - id: miro-oauth-client-id
    kind: oauth
    required: false
    secret_ref:
      source: store
      id: MIRO_CLIENT_ID
    scope: "https://miro.com/oauth/authorize"
    how_to_obtain: "Create a Miro app. Set `MIRO_CLIENT_ID` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set MIRO_CLIENT_ID \"<client-id>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set MIRO_CLIENT_ID \"<client-id>\"`. Do this before token exchange."
  - id: miro-oauth-client-secret
    kind: oauth
    required: false
    secret_ref:
      source: store
      id: MIRO_CLIENT_SECRET
    scope: "https://api.miro.com/v1/oauth/token"
    how_to_obtain: "Set the Miro app client secret as `MIRO_CLIENT_SECRET` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set MIRO_CLIENT_SECRET \"<client-secret>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set MIRO_CLIENT_SECRET \"<client-secret>\"`. Never paste it into prompts or helper arguments."
  - id: miro-oauth-code
    kind: oauth
    required: false
    secret_ref:
      source: store
      id: MIRO_OAUTH_CODE
    scope: "one-time OAuth authorization code"
    how_to_obtain: "After approving the Miro authorize URL, set the one-time code as `MIRO_OAUTH_CODE` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set MIRO_OAUTH_CODE \"<code>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set MIRO_OAUTH_CODE \"<code>\"`. Exchange it immediately."
  - id: miro-refresh-token
    kind: oauth
    required: false
    secret_ref:
      source: store
      id: MIRO_REFRESH_TOKEN
    scope: "https://api.miro.com/v1/oauth/token refresh_token"
    how_to_obtain: "The helper captures this from Miro OAuth token responses with `captureResponseFields`; do not set it manually unless recovering a known stored token."
metadata:
  hybridclaw:
    category: productivity
    short_description: "Miro board discovery, item reads, guarded board writes, and Enterprise board exports."
    tags:
      - miro
      - whiteboard
      - boards
      - sticky-notes
      - diagrams
      - export
    related_roadmap:
      - R21.102
    issue: 1040
    stakes_tiers:
      green:
        - board-list
        - board-metadata-read
        - board-item-read
        - export-status-read
      amber:
        - sticky-note-create-update
        - text-create-update
        - shape-create-update
        - connector-create-update
        - frame-create-update
        - enterprise-export-create
        - enterprise-export-link
      red:
        - board-delete
        - item-delete
        - permission-share-change
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: miro
---

# Miro

Use this skill for Miro board work through the REST API: board discovery,
metadata lookup, board item reads for summaries or planning, guarded creation
and updates for common board items, and Enterprise board export jobs when the
operator has Discovery access.

## Scope

- list accessible boards and fetch board metadata
- read board items by type for audit-safe context capture and summaries
- fetch specific sticky note, text, shape, connector, and frame items
- create or update sticky notes, text items, shapes, connectors, and frames only
  after preview and explicit operator grant
- create and inspect Enterprise board export jobs, including result/task lookup
  and export-link creation where the API supports it
- download completed Enterprise export links into local workspace artifacts
- classify missing credential, upstream auth/scope, rate-limit, and API errors
- refuse deletes and permission/share changes in this v1 skill

## Credential Rules

Store Miro tokens in HybridClaw runtime secrets. Never paste a raw Miro token
into the prompt, a helper argument, a shell environment dump, or a log.

Recommended setup order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets` and set the
   needed `MIRO_*` secrets.
2. Browser `/chat` or TUI fallback:
   `/secret set MIRO_ACCESS_TOKEN "<oauth-or-access-token>"` plus any needed
   Discovery or OAuth client secrets.
3. Local console fallback:

```bash
hybridclaw secret set MIRO_ACCESS_TOKEN "<oauth-or-access-token>"
hybridclaw secret set MIRO_DISCOVERY_ACCESS_TOKEN "<enterprise-discovery-token>"
hybridclaw secret set MIRO_CLIENT_ID "<miro-client-id>"
hybridclaw secret set MIRO_CLIENT_SECRET "<miro-client-secret>"
```

Use `MIRO_ACCESS_TOKEN` for normal board APIs. Required Miro scopes depend on
the operation:

- board discovery and item reads: `boards:read`
- sticky notes, text, shapes, connectors, and frames: `boards:write`

Use `MIRO_DISCOVERY_ACCESS_TOKEN` only for Enterprise board export APIs that
require `boards:export`. Enterprise export requires a Miro Enterprise plan,
Company Admin role, and enabled eDiscovery.

For Miro OAuth app authorization, use the helper to build the authorize URL,
store the callback code as `MIRO_OAUTH_CODE`, and then exchange the code through
the gateway. The exchange request uses `<secret:MIRO_CLIENT_ID>`,
`<secret:MIRO_CLIENT_SECRET>`, and `<secret:MIRO_OAUTH_CODE>` placeholders and
captures `access_token` into `MIRO_ACCESS_TOKEN` and `refresh_token` into
`MIRO_REFRESH_TOKEN` with `captureResponseFields`.

Do not try to verify either secret with `bash`, environment inspection, or by
asking the model whether a secret exists. The model cannot inspect the gateway
secret store. If the operator says the secret was set, build the helper request
and pass the `httpRequest` object to the built-in `http_request` tool. Only say
a secret is missing if the gateway or helper error explicitly says
`MIRO_ACCESS_TOKEN` or `MIRO_DISCOVERY_ACCESS_TOKEN` is missing, unavailable,
not set, or unresolved.

## Default Workflow

1. Start with `list-boards` unless the board id is already known.
2. Fetch board metadata with `get-board` before summarizing ownership, sharing,
   or last-modified context.
3. Read board items with `list-items`, filtered by `--type` when the task is
   about a specific surface such as sticky notes, text, shapes, connectors, or
   frames.
4. For large boards, page with the returned cursor and keep summaries bounded to
   relevant item types and regions named by the operator.
5. For any board write, run `approval-plan` or `--request` first, show the
   preview, then wait for explicit approval.
6. Pass `--operator-grant approve-miro-board-write` only after approval for the
   exact board id, operation, and payload.
7. For Enterprise exports, use `approval-plan export-create` before creating an
   export job and `approval-plan export-link` before minting a download link.
   Pass `--operator-grant approve-miro-export` only after approval for the
   exact org id, board id or task id, and export format.
8. After `export-results` returns an `exportLink`, use `capture-export` to save
   the ZIP/PDF/HTML/SVG export under `.generated-miro` and return the helper's
   `artifacts[]` output.
9. Do not delete items, delete boards, or change board permissions through this
   skill.

## Command Contract

Run the colocated helper with Node:

```bash
node skills/miro/miro.cjs --help
```

Plan a request without contacting Miro:

```bash
node skills/miro/miro.cjs --format json plan "Summarize sticky notes on this Miro board"
```

Build the OAuth authorize URL:

```bash
node skills/miro/miro.cjs --format json oauth authorize-url \
  --client-id "<miro-client-id>" \
  --redirect-uri "http://127.0.0.1:1455/oauth2/callback" \
  --scope boards:read \
  --scope boards:write
```

After the operator approves the URL and stores the callback code with
`hybridclaw secret set MIRO_OAUTH_CODE "<code>"`, exchange it without exposing
the code or resulting tokens:

```bash
node skills/miro/miro.cjs --format json http-request oauth-exchange-code \
  --redirect-uri "http://127.0.0.1:1455/oauth2/callback"
```

For expiring-token apps, refresh tokens through the same secret-capture path:

```bash
node skills/miro/miro.cjs --format json http-request oauth-refresh-token
```

Build read requests:

```bash
node skills/miro/miro.cjs --format json http-request list-boards \
  --query roadmap \
  --limit 20

node skills/miro/miro.cjs --format json http-request get-board \
  --board-id uXjVOD50NUI=

node skills/miro/miro.cjs --format json http-request list-items \
  --board-id uXjVOD50NUI= \
  --type sticky_note \
  --limit 50

node skills/miro/miro.cjs --format json http-request get-item \
  --board-id uXjVOD50NUI= \
  --type sticky_note \
  --item-id "3458764511234567890"
```

The helper prints `{ "command": "http-request", "httpRequest": { ... } }`.
Pass only the `httpRequest` value to the built-in `http_request` tool for live
API calls. The helper sets `bearerSecretName` so the gateway injects the token
server-side.

Preview and approve board writes:

```bash
node skills/miro/miro.cjs --format json approval-plan create-sticky-note \
  --board-id uXjVOD50NUI= \
  --content "Decision: proceed with option B" \
  --x 0 \
  --y 0

node skills/miro/miro.cjs --format json http-request create-sticky-note \
  --board-id uXjVOD50NUI= \
  --content "Decision: proceed with option B" \
  --x 0 \
  --y 0 \
  --operator-grant approve-miro-board-write
```

Supported write operations:

- `create-sticky-note`, `update-sticky-note`
- `create-text`, `update-text`
- `create-shape`, `update-shape`
- `create-connector`, `update-connector`
- `create-frame`, `update-frame`

Use structured flags for common payload fields: `--content`, `--title`,
`--shape`, `--x`, `--y`, `--width`, `--height`, `--parent-id`,
`--style-json`, `--position-json`, `--geometry-json`, and `--data-json`.
For connector creation, provide `--start-item-id` and `--end-item-id`; optional
`--start-snap-to`, `--end-snap-to`, `--shape`, `--captions-json`, and
`--style-json` map to the Miro connector request body.

Use `--payload-json` only when the operator has supplied a known-good Miro REST
payload shape that the structured flags cannot represent. Still run
`approval-plan` first and keep the payload minimal.

Enterprise export workflow:

```bash
node skills/miro/miro.cjs --format json approval-plan export-create \
  --org-id 3074457345821141000 \
  --board-id uXjVOD50NUI= \
  --request-id 92343229-c532-446d-b8cb-2f155bedb807 \
  --board-format PDF

node skills/miro/miro.cjs --format json http-request export-status \
  --org-id 3074457345821141000 \
  --job-id 92343229-c532-446d-b8cb-2f155bedb807

node skills/miro/miro.cjs --format json http-request export-results \
  --org-id 3074457345821141000 \
  --job-id 92343229-c532-446d-b8cb-2f155bedb807

node skills/miro/miro.cjs --format json capture-export \
  --export-url "https://..." \
  --filename "miro-board-export.zip"
```

## Error Interpretation

- Gateway errors saying `MIRO_ACCESS_TOKEN` is missing, not set, unavailable,
  or unresolved: ask the operator to set the runtime secret in the same
  HybridClaw runtime, then retry in a fresh agent runtime if the gateway was
  already running.
- Gateway errors saying `MIRO_DISCOVERY_ACCESS_TOKEN` is missing: Enterprise
  export APIs cannot run until a Discovery token is stored.
- Gateway errors saying `MIRO_CLIENT_ID`, `MIRO_CLIENT_SECRET`,
  `MIRO_OAUTH_CODE`, or `MIRO_REFRESH_TOKEN` is missing: the OAuth setup step
  has not stored the required secret in the active runtime.
- Gateway errors saying the secret is blocked by policy: report a
  policy/runtime configuration problem; do not ask the operator to set the same
  secret again.
- Miro 401 or 403 responses: the gateway injected a token, but Miro rejected it
  or the token lacks the needed board, organization, Enterprise, or OAuth scope.
- Miro 429 responses: back off and preserve cursor/request-id values for
  idempotent retries.
- Miro 5xx responses: report the upstream failure and retry only if the user
  asks and the operation is idempotent.

The helper can classify common failures offline:

```bash
node skills/miro/miro.cjs --format json explain-error \
  --status 403 \
  --message "insufficient scope"
```

## References

- Miro REST API v2 board discovery: https://developers.miro.com/reference/get-boards
- Miro REST API v2 board items: https://developers.miro.com/reference/get-items
- Miro REST API v2 sticky note items: https://developers.miro.com/reference/create-sticky-note-item
- Miro REST API v2 connectors: https://developers.miro.com/reference/create-connector
- Miro Enterprise board export: https://developers.miro.com/reference/board-export
