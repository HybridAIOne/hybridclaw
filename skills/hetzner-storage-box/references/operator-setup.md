# Hetzner Storage Box Operator Setup

## API Token

Create a Hetzner Console API token in the project containing the Storage Box.
Use read-only scope for inventory. Use read-write scope only for approved
management changes such as snapshots, settings, creation, and deletion.

Store it in the encrypted runtime secret store:

```bash
hybridclaw secret set HETZNER_API_TOKEN "<hetzner-console-api-token>"
```

## WebDAV File Credentials

For file operations, create a Storage Box subaccount with the narrowest path and
permission set that fits the task. Prefer read-only subaccounts for inspection
and dedicated write subaccounts for archive uploads.

Store only the base64 payload for Basic auth:

```bash
printf '%s' 'u00000:storage-box-password' | base64
hybridclaw secret set HETZNER_STORAGE_BOX_BASIC_AUTH "<base64-username-password>"
```

The helper emits `secretHeaders` so HybridClaw injects
`Authorization: Basic <secret>` server-side. Do not paste the password or the
encoded secret into chat, logs, or command lines beyond the one-time local
secret setup.

## Recommended Autonomy

- Inventory and file reads: allow read-only autonomy for trusted operators.
- Uploads, archives, public-link handoffs, snapshot creation, and setting
  changes: `confirm-each`.
- Storage Box deletion, snapshot deletion, and WebDAV deletes: exact target
  confirmation every time.
