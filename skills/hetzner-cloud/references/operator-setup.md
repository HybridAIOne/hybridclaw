# Hetzner Cloud Operator Setup

## API Token

Create a Hetzner Console API token in the Cloud project that owns the servers,
volumes, networks, images, and snapshots the operator wants HybridClaw to
inspect or manage.

Use read-only scope for inventory, location, server-type, price, network,
volume, and image reads. Use read-write scope only for a bounded mutation
window when the operator has approved provisioning, snapshot, restore, network,
volume, or delete actions.

Set the token in the encrypted runtime secret store in this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback:
   `/secret set HETZNER_API_TOKEN "<hetzner-console-api-token>"`.
3. Local console fallback:

```bash
hybridclaw secret set HETZNER_API_TOKEN "<hetzner-console-api-token>"
```

The helper emits `bearerSecretName: "HETZNER_API_TOKEN"` so HybridClaw injects
the bearer token server-side. Do not paste the token into chat, logs, helper
arguments, eval fixtures, or documentation examples.

Use `hetzner_cloud.cjs` as the Cloud API wrapper; it owns endpoints, methods,
payloads, tiers, and the `bearerSecretName` secret reference. For prompt/user
testing, use `plan` or helper `http-request` commands only. For real user
requests that need live Hetzner data, execute the emitted payload with the
built-in `http_request` tool unchanged and let the gateway resolve
`bearerSecretName`. If a live call returns 401 or 403, stop after the first
failure and ask the operator to verify `HETZNER_API_TOKEN`.

## Recommended Autonomy

- Inventory, pricing, server-type, location, image, volume, and network reads:
  allow read-only autonomy for trusted operators.
- Server provisioning, snapshot creation, volume attachment, volume detachment,
  network attachment, and network detachment: `confirm-each`.
- Server deletion, VPS deletion, snapshot deletion, volume deletion, and
  snapshot restore: exact target confirmation every time.

## Cost Reporting

`list-prices` returns the Hetzner Cloud pricing catalog and `list-servers`
returns the project inventory. Monthly cost estimates require joining those
read results by server type, location, and resource shape in the assistant
workflow. The helper does not make hidden billing calls or compute totals
without showing the underlying inventory and price reads first.
