---
name: hetzner-storage-box
description: "Read and operate Hetzner Storage Boxes through Hetzner API management calls and WebDAV file requests with gateway-injected credentials."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: hetzner-api-token
    kind: bearer
    required: true
    secret_ref:
      source: store
      id: HETZNER_API_TOKEN
    scope: "api.hetzner.com/v1/storage_boxes"
    how_to_obtain: "Create a Hetzner Console API token for the project containing the Storage Box. Use read-only scope for inventory and read-write scope only for approved Storage Box management changes. Set `HETZNER_API_TOKEN` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set HETZNER_API_TOKEN \"<hetzner-console-api-token>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set HETZNER_API_TOKEN \"<hetzner-console-api-token>\"`."
  - id: hetzner-storage-box-basic-auth
    kind: header
    required: false
    secret_ref:
      source: store
      id: HETZNER_STORAGE_BOX_BASIC_AUTH
    scope: "*.your-storagebox.de WebDAV Authorization header"
    how_to_obtain: "Base64-encode '<storage-box-username>:<password>' and store only that encoded value. Set `HETZNER_STORAGE_BOX_BASIC_AUTH` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set HETZNER_STORAGE_BOX_BASIC_AUTH \"<base64-username-password>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set HETZNER_STORAGE_BOX_BASIC_AUTH \"<base64-username-password>\"`. The helper injects it as 'Authorization: Basic <secret>' for WebDAV file operations."
metadata:
  hybridclaw:
    category: infrastructure
    short_description: "Hetzner Storage Box inventory, snapshots, and guarded WebDAV file operations."
    tags:
      - hetzner
      - storage-box
      - webdav
      - archive
      - infrastructure
    stakes_tiers:
      green:
        - list-storage-boxes
        - get-storage-box
        - list-snapshots
        - list-files
        - download-file
        - public-url
      amber:
        - share-public-link
        - create-storage-box
        - update-storage-box
        - create-snapshot
        - upload-text
        - create-directory
        - archive-text
      red:
        - delete-storage-box
        - delete-snapshot
        - delete-path
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: hetzner-storage-box
---

# Hetzner Storage Box

Use this skill for Storage Box inventory, lifecycle and snapshot management,
plus WebDAV file reads and guarded uploads/archives.

## Default Workflow

1. Use Hetzner API reads (`list-storage-boxes`, `get-storage-box`) for inventory
   and metadata.
2. Use WebDAV reads (`list-files`, `download-file`) for file inspection.
3. Use `plan` before any management, file write, or public-link request.
4. Treat `hetzner_storage_box.cjs` as the API/WebDAV wrapper. Do not handcraft
   Hetzner Storage Box API URLs, WebDAV URLs, JSON bodies, tiers, or secret refs
   from memory.
5. For prompt/user testing, stop after `plan` or after helper payload
   generation. Do not call the built-in `http_request` tool.
6. For real user requests that need live Storage Box API or WebDAV reads, pass
   the helper-emitted `httpRequest` object unchanged to `http_request`. The
   `bearerSecretName` or `secretHeaders` field is the secret reference; do not
   rewrite it, preflight it, inspect it, or ask the model for the secret.
7. If a live `http_request` call returns 401 or 403, stop after that first
   failure. Do not retry, do not fan out to more endpoints or paths, and ask the
   operator to set or verify the relevant secret.
8. Require explicit operator grant before creating boxes, changing settings,
   snapshots, uploads, archives, directory creation, public sharing, or deletes.
9. Never paste, print, or inspect `HETZNER_API_TOKEN` or Storage Box passwords.
   The gateway injects API bearer tokens and WebDAV Basic auth server-side.

## Secret Setup

API management calls use `HETZNER_API_TOKEN`. Set or update it in this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback:
   `/secret set HETZNER_API_TOKEN "<hetzner-console-api-token>"`.
3. Local console fallback:

```bash
hybridclaw secret set HETZNER_API_TOKEN "<hetzner-console-api-token>"
```

`HETZNER_API_TOKEN` is the Hetzner Console token for Cloud and Storage Box
management APIs. DNS uses its own `HETZNER_DNS_API_TOKEN` because Hetzner DNS is
served by a separate DNS API and `Auth-API-Token` header.

WebDAV file operations use a Basic-auth secret containing only the base64
encoded `username:password` payload. Set it in the same order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback:
   `/secret set HETZNER_STORAGE_BOX_BASIC_AUTH "<base64-username-password>"`.
3. Local console fallback:

```bash
printf '%s' 'u00000:storage-box-password' | base64
hybridclaw secret set HETZNER_STORAGE_BOX_BASIC_AUTH "<base64-username-password>"
```

See [references/operator-setup.md](references/operator-setup.md) for operator
setup, scope, and autonomy defaults.

## Command Contract

```bash
node skills/hetzner-storage-box/hetzner_storage_box.cjs --help
```

Build management API requests:

```bash
node skills/hetzner-storage-box/hetzner_storage_box.cjs --format json http-request list-storage-boxes
node skills/hetzner-storage-box/hetzner_storage_box.cjs --format json http-request get-storage-box --box-id 123456
node skills/hetzner-storage-box/hetzner_storage_box.cjs --format json http-request create-snapshot --box-id 123456 --description "pre-archive" --operator-grant
```

Build WebDAV file requests:

```bash
node skills/hetzner-storage-box/hetzner_storage_box.cjs --format json webdav-request list-files \
  --host u00000.your-storagebox.de --path /archives

node skills/hetzner-storage-box/hetzner_storage_box.cjs --format json webdav-request upload-text \
  --host u00000.your-storagebox.de --path /archives/q4-invoices/manifest.txt \
  --body "Archived Q4 invoices" --operator-grant

node skills/hetzner-storage-box/hetzner_storage_box.cjs --format json public-url \
  --host u00000.your-storagebox.de --path /archives/q4-invoices.zip

node skills/hetzner-storage-box/hetzner_storage_box.cjs --format json share-public-link \
  --host u00000.your-storagebox.de --path /archives/q4-invoices.zip \
  --expires-at 2026-06-30 --operator-grant
```

## Working Rules

- Prefer read-only API tokens and read-only Storage Box subaccounts for file
  inspection.
- Treat `delete-storage-box`, `delete-snapshot`, and `delete-path` as red-risk
  actions requiring exact target confirmation.
- Use WebDAV over HTTPS for file operations unless the operator explicitly asks
  for SFTP/rsync outside this helper.
- `public-url` only constructs the URL for a path that is already public.
  `share-public-link` is the guarded operator handoff for publishing a path and
  recording its intended expiration. Storage Box file access is credentialed by
  default, so do not present a path as public until the operator confirms the
  serving configuration.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` for eval verification.

## Eval Suite

```bash
node skills/hetzner-storage-box/hetzner_storage_box.cjs --format json eval-scenarios
```

The fixture at `evals/scenarios.json` contains 10 scenarios covering inventory,
snapshots, WebDAV list/download/upload/archive, public links, and deletes.

## Validation

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/hetzner-storage-box
node skills/hetzner-storage-box/hetzner_storage_box.cjs --help
node skills/hetzner-storage-box/hetzner_storage_box.cjs --format json eval-scenarios
```
