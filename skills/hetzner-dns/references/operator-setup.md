# Hetzner DNS Operator Setup

## DNS API Token

Hetzner DNS uses the DNS Console and DNS API, not the Hetzner Cloud bearer-token
API. Create a DNS API token in the Hetzner DNS Console for the account that owns
the target zones.

Store the token in the encrypted runtime secret store:

```bash
hybridclaw secret set HETZNER_DNS_API_TOKEN "<hetzner-dns-api-token>"
```

The helper emits a `secretHeaders` entry so HybridClaw injects
`Auth-API-Token: <secret>` server-side. This separate secret is intentional:
`HETZNER_API_TOKEN` remains the Hetzner Console token for Cloud and Storage Box
management APIs, while `HETZNER_DNS_API_TOKEN` matches the DNS API auth
contract.

Do not paste the DNS token into chat, logs, helper arguments, eval fixtures, or
documentation examples.

Use `hetzner_dns.cjs` as the DNS API wrapper; it owns endpoints, methods,
payloads, tiers, and the `Auth-API-Token` secret header. For prompt/user
testing, use `plan` or helper `http-request` commands only. For real user
requests that need live Hetzner DNS data, execute the emitted payload with the
built-in `http_request` tool unchanged and let the gateway resolve the
`Auth-API-Token` secret header. If a live call returns 401 or 403, stop after
the first failure and ask the operator to verify `HETZNER_DNS_API_TOKEN`.

## Recommended Autonomy

- Zone and record reads: allow read-only autonomy for trusted operators.
- Record creation, record updates, adding values, and removing values:
  `confirm-each`.
- Record deletion and zone deletion: exact record id or zone id confirmation
  every time.

## Record IDs

The DNS API is record-id based for updates and deletes. Always list records for
the target zone first, confirm the exact `record-id`, and use one write request
per DNS record value. The helper rejects unsupported `--comment` metadata
because the DNS record endpoint does not accept it.
