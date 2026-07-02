# Hetzner Storage Box Operator Setup

## API Token

Create a Hetzner Console API token in the project containing the Storage Box.
Use read-only scope for inventory. Use read-write scope only for approved
management changes such as snapshots, settings, creation, and deletion.

Set it in the encrypted runtime secret store in this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback:
   `/secret set HETZNER_API_TOKEN "<hetzner-console-api-token>"`.
3. Local console fallback:

```bash
hybridclaw secret set HETZNER_API_TOKEN "<hetzner-console-api-token>"
```

## WebDAV File Credentials

For file operations, create a Storage Box subaccount with the narrowest path and
permission set that fits the task. Prefer read-only subaccounts for inspection
and dedicated write subaccounts for archive uploads.

Set only the base64 payload for Basic auth in the same order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback:
   `/secret set HETZNER_STORAGE_BOX_BASIC_AUTH "<base64-username-password>"`.
3. Local console fallback:

```bash
printf '%s' 'u00000:storage-box-password' | base64
hybridclaw secret set HETZNER_STORAGE_BOX_BASIC_AUTH "<base64-username-password>"
```

The helper emits `secretHeaders` so HybridClaw injects
`Authorization: Basic <secret>` server-side. Do not paste the password or the
encoded secret into chat, logs, or command lines beyond the one-time local
secret setup.

Use `hetzner_storage_box.cjs` as the API/WebDAV wrapper; it owns endpoints, URL
encoding, methods, payloads, tiers, and secret refs. For prompt/user testing,
use `plan`, `public-url`, or helper payload-generation commands only. For real
user requests that need live Storage Box data, execute emitted API or WebDAV
payloads with the built-in `http_request` tool unchanged and let the gateway
resolve the secret reference. If a live call returns 401 or 403, stop after the
first failure and ask the operator to verify `HETZNER_API_TOKEN` or
`HETZNER_STORAGE_BOX_BASIC_AUTH`.

## Recommended Autonomy

- Inventory and file reads: allow read-only autonomy for trusted operators.
- Uploads, archives, public-link handoffs, snapshot creation, and setting
  changes: `confirm-each`.
- Storage Box deletion, snapshot deletion, and WebDAV deletes: exact target
  confirmation every time.
