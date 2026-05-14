---
name: hetzner-dns
description: "Read and manage Hetzner DNS zones and RRsets through gateway-proxied Cloud API requests with guarded A, AAAA, CNAME, and TXT changes."
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
    scope: "api.hetzner.cloud/v1/zones"
    how_to_obtain: "Create a Hetzner Console API token for the project containing the DNS zone. Use read-only scope for inspection and read-write scope only for approved RRset changes."
metadata:
  hybridclaw:
    category: infrastructure
    short_description: "Hetzner DNS zone and RRset reads plus guarded record changes."
    tags:
      - hetzner
      - dns
      - rrset
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
RRset management through the Hetzner Cloud API.

## Default Workflow

1. Read first: list zones, then list RRsets for the target zone.
2. Treat DNS as RRsets. A name and type pair owns one TTL and one record list.
3. Use `plan` before mutations so the operator can see the tier and required
   grant.
4. Use the helper to produce `http_request` payloads; pass only the emitted
   `httpRequest` object to the built-in `http_request` tool.
5. Require explicit operator grant before creating, updating, adding, removing,
   or deleting records. Pass `--operator-grant` only after that grant.
6. Never paste, print, or inspect `HETZNER_API_TOKEN`; the gateway injects it
   server-side with `bearerSecretName: "HETZNER_API_TOKEN"`.

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
node skills/hetzner-dns/hetzner_dns.cjs --format json http-request list-rrsets --zone example.com
node skills/hetzner-dns/hetzner_dns.cjs --format json http-request get-rrset --zone example.com --name demo --type A
```

Build guarded write requests:

```bash
node skills/hetzner-dns/hetzner_dns.cjs --format json http-request create-rrset \
  --zone example.com --name demo --type A --ttl 300 --record 203.0.113.10 \
  --comment "customer demo" --operator-grant

node skills/hetzner-dns/hetzner_dns.cjs --format json http-request update-rrset \
  --zone example.com --name demo --type A --ttl 300 --record 203.0.113.11 \
  --operator-grant

node skills/hetzner-dns/hetzner_dns.cjs --format json http-request delete-record \
  --zone example.com --name demo --type A --operator-grant
```

## Working Rules

- Prefer `create-rrset` or `update-rrset` for full desired state changes.
- Use `add-record` and `remove-record` only when the user explicitly asks to
  mutate one value within an existing RRset.
- Do not modify generated SOA records or default NS records.
- Use `@` for apex records when the API requires an RRset name.
- Stop before red actions (`delete-record`, `delete-rrset`, `delete-zone`)
  unless the operator grants the exact zone/name/type target.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` for eval verification.

## Eval Suite

```bash
node skills/hetzner-dns/hetzner_dns.cjs --format json eval-scenarios
```

The fixture at `evals/scenarios.json` contains 10 DNS scenarios covering zone
reads, RRset reads, A/AAAA/CNAME/TXT changes, and guarded deletes.

## Validation

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/hetzner-dns
node skills/hetzner-dns/hetzner_dns.cjs --help
node skills/hetzner-dns/hetzner_dns.cjs --format json eval-scenarios
```
