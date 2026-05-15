---
name: hetzner-dns
description: "Read and manage Hetzner DNS zones and records through gateway-proxied DNS API requests with guarded A, AAAA, CNAME, and TXT changes."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: hetzner-dns-api-token
    kind: header
    required: true
    secret_ref:
      source: store
      id: HETZNER_DNS_API_TOKEN
    scope: "dns.hetzner.com/api/v1"
    how_to_obtain: "Create a DNS API access token in the Hetzner DNS Console and store it as HETZNER_DNS_API_TOKEN. The helper injects it into the Auth-API-Token header server-side."
metadata:
  hybridclaw:
    category: infrastructure
    short_description: "Hetzner DNS zone and record reads plus guarded record changes."
    tags:
      - hetzner
      - dns
      - records
      - infrastructure
    stakes_tiers:
      green:
        - list-zones
        - get-zone
        - list-rrsets
        - get-rrset
      amber:
        - create-rrset
        - update-rrset
        - add-record
        - remove-record
      red:
        - delete-record
        - delete-rrset
        - delete-zone
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: hetzner-dns
---

# Hetzner DNS

Use this skill for Hetzner DNS zone discovery and A, AAAA, CNAME, TXT, and other
record management through the Hetzner DNS API.

## Default Workflow

1. Read first: list zones, then list records for the target zone id.
2. The DNS API is record-id based. Use `list-rrsets` to discover existing record
   ids before update or delete requests.
3. Use `plan` before mutations so the operator can see the tier and required
   grant.
4. Use the helper to produce `http_request` payloads; pass only the emitted
   `httpRequest` object to the built-in `http_request` tool.
5. Require explicit operator grant before creating, updating, adding, removing,
   or deleting records. Pass `--operator-grant` only after that grant.
6. Never paste, print, or inspect `HETZNER_DNS_API_TOKEN`; the gateway injects
   it server-side as `Auth-API-Token`.

See [references/operator-setup.md](references/operator-setup.md) for DNS token
setup, scope, autonomy defaults, and record-id handling.

## Command Contract

```bash
node skills/hetzner-dns/hetzner_dns.cjs --help
```

Plan a DNS request without contacting Hetzner:

```bash
node skills/hetzner-dns/hetzner_dns.cjs --format json plan "Point demo-acme.example.com at the demo VPS"
```

Build read requests:

```bash
node skills/hetzner-dns/hetzner_dns.cjs --format json http-request list-zones
node skills/hetzner-dns/hetzner_dns.cjs --format json http-request list-rrsets --zone-id zone123 --name demo --type A
node skills/hetzner-dns/hetzner_dns.cjs --format json http-request get-rrset --record-id record123
```

Build guarded write requests:

```bash
node skills/hetzner-dns/hetzner_dns.cjs --format json http-request create-rrset \
  --zone-id zone123 --name demo --type A --ttl 300 --record 203.0.113.10 \
  --operator-grant

node skills/hetzner-dns/hetzner_dns.cjs --format json http-request update-rrset \
  --record-id record123 --zone-id zone123 --name demo --type A --ttl 300 --record 203.0.113.11 \
  --operator-grant

node skills/hetzner-dns/hetzner_dns.cjs --format json http-request delete-record \
  --record-id record123 --operator-grant
```

## Working Rules

- `create-rrset` and `add-record` emit one DNS API record create request. For
  multiple values, build one request per value.
- Use `update-rrset` only with an exact `--record-id` from a prior read.
- Use `remove-record`, `delete-record`, or `delete-rrset` only with an exact
  `--record-id`.
- Do not modify generated SOA records or default NS records.
- Use `@` for apex records when the API requires a record name.
- Stop before red actions (`delete-record`, `delete-rrset`, `delete-zone`)
  unless the operator grants the exact record id or zone id target.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` for eval verification.

## Eval Suite

```bash
node skills/hetzner-dns/hetzner_dns.cjs --format json eval-scenarios
```

The fixture at `evals/scenarios.json` contains 10 DNS scenarios covering zone
reads, record reads, A/AAAA/CNAME/TXT changes, and guarded deletes.

## Validation

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/hetzner-dns
node skills/hetzner-dns/hetzner_dns.cjs --help
node skills/hetzner-dns/hetzner_dns.cjs --format json eval-scenarios
```
