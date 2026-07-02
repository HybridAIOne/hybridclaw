---
name: airtable
description: "Search Airtable bases and tables, read records and computed fields, and prepare guarded record CRUD requests with schema-based field validation."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: airtable-pat
    kind: bearer
    required: true
    secret_ref:
      source: store
      id: AIRTABLE_PAT
    scope: "api.airtable.com/v0"
    how_to_obtain: "Create an Airtable Personal Access Token or OAuth bearer token with the needed scopes. Set `AIRTABLE_PAT` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set AIRTABLE_PAT \"<token>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set AIRTABLE_PAT \"<token>\"`."
metadata:
  hybridclaw:
    category: productivity
    short_description: "Airtable bases, tables, records, attachments, and safe writes."
    tags:
      - airtable
      - records
      - bases
      - tables
      - attachments
      - formulas
    stakes_tiers:
      green:
        - base-list
        - schema-read
        - record-read
        - formula-field-read
      amber:
        - record-create
        - record-update
        - attachment-update
      red:
        - record-delete
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_contract: R5.4
      sub_limit_key: airtable
---

# Airtable

Use this skill for Airtable Web API work: base and table discovery, schema
inspection, record reads, field-aware record creation and updates, attachment
field payloads, formula/lookup/rollup reads, and carefully gated deletes.

## Scope

- list accessible bases
- inspect base table schemas, field ids, field names, field types, and select
  choices
- list records with pagination, views, field selection, and `filterByFormula`
- fetch a single record by id
- create, update, and delete records only after explicit operator grant
- validate field values against Airtable metadata before writes when schema is
  available
- prepare attachment field values from public `http(s)` URLs
- read formula, lookup, rollup, count, autonumber, created time, and last
  modified time fields as normal record values
- refuse writes to computed/read-only field types
- measure skill run cost through normal HybridClaw `UsageTotals`

## Credential Rules

Airtable uses Personal Access Tokens or OAuth bearer tokens. Store the token in
HybridClaw encrypted runtime secrets; never paste it into the prompt.

Recommended setup order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets` and set
   `AIRTABLE_PAT`.
2. Browser `/chat` or TUI fallback:
   `/secret set AIRTABLE_PAT "<pat-or-oauth-access-token>"`.
3. Local console fallback:

```bash
hybridclaw secret set AIRTABLE_PAT "<pat-or-oauth-access-token>"
```

For live API calls inside HybridClaw, use the helper to build the
`http_request` payload wrapper, then pass the emitted inner `httpRequest` object
to the built-in `http_request` tool. The helper sets
`bearerSecretName: "AIRTABLE_PAT"` on that inner object so the gateway injects
the bearer token server-side. Do not use bash/curl for live Airtable calls when
`http_request` is available, and do not ask the user to store a HybridClaw
gateway token as an Airtable secret.

Do not try to verify `AIRTABLE_PAT` with `bash`, environment inspection, or by
asking the model whether the secret exists. The model cannot inspect the gateway
secret store. If the operator says the secret was set, attempt the
`http_request` call with `bearerSecretName: "AIRTABLE_PAT"`. Only say the secret
is missing if the built-in `http_request` tool returns a gateway error that
explicitly says `AIRTABLE_PAT` is not set, unavailable, missing, or unresolved.
If the error says the secret is blocked by policy, report a policy/runtime
configuration problem instead of asking the operator to set the same secret
again.

Required Airtable PAT scopes depend on the task:

- base discovery: `schema.bases:read`
- schema inspection: `schema.bases:read`
- record reads: `data.records:read`
- record creates, updates, attachments, and deletes: `data.records:write`

## Error Interpretation

- Gateway errors saying `AIRTABLE_PAT` is not set, unavailable, missing, or
  unresolved: the active gateway runtime cannot resolve that stored secret. Ask
  the operator to set it in the same HybridClaw runtime/session in this order:
  browser admin at the active `/admin/secrets` route,
  `/secret set AIRTABLE_PAT <pat>` in browser `/chat` or TUI, then local
  console fallback
  `hybridclaw secret set AIRTABLE_PAT <pat>`, then start a fresh agent runtime
  if the gateway was already running.
- Gateway errors saying `AIRTABLE_PAT` is blocked by secret resolution policy:
  report that the stored secret exists but policy/runtime access blocked the
  injection path. Do not ask the operator to set the same secret again.
- Airtable 401 or 403 responses: the gateway injected a token, but Airtable
  rejected it or the PAT lacks the needed scopes/base access. Ask the operator
  to check PAT scopes and base access; do not say the secret is unconfigured.
- Network or Airtable 5xx responses: report the upstream failure and retry only
  if the user asks.

## Default Workflow

1. Start with base and table discovery unless the base id and table id are
   already known.
2. If the user asks to list tables and does not provide a base id, first call
   `list-bases` through `http_request`, then call `schema --base-id ...` for
   each relevant base returned by Airtable.
3. Read table schema before writes so field ids, field types, select choices,
   and computed fields are known.
4. Use `plan` for natural-language requests when you need a mutation tier before
   execution.
5. Use `validate-fields` or `--schema-file` on write payload builders before
   creating or updating records.
6. For writes, stop unless the operator has granted that exact mutation in the
   current task.
7. Pass `--operator-grant` only after explicit approval or an approved F14
   escalation.
8. Prefer table ids and field ids over names for durable automation. Table names
   work but are rename-sensitive.
9. When deleting records, use exact record ids only.

## Command Contract

Run the colocated helper with Node:

```bash
node skills/airtable/airtable.cjs --help
```

Plan a natural-language request without contacting Airtable:

```bash
node skills/airtable/airtable.cjs plan "Update the status field on this Airtable task"
```

List bases:

```bash
node skills/airtable/airtable.cjs http-request list-bases
```

The helper prints a wrapper such as
`{ "command": "http-request", "httpRequest": { ... } }`. Pass only the
`httpRequest` value to the built-in `http_request` tool.

Get base schema:

```bash
node skills/airtable/airtable.cjs http-request schema --base-id appXXXXXXXXXXXXXX
```

List records:

```bash
node skills/airtable/airtable.cjs http-request list-records \
  --base-id appXXXXXXXXXXXXXX \
  --table tblXXXXXXXXXXXXXX \
  --field Name \
  --field Status \
  --filter-by-formula "{Status} = 'Active'" \
  --page-size 100
```

Airtable returns list-record results in pages of up to 100 records. If the
response includes `offset`, run the same command with `--offset <offset>` to
fetch the next page.

Get a record:

```bash
node skills/airtable/airtable.cjs http-request get-record \
  --base-id appXXXXXXXXXXXXXX \
  --table tblXXXXXXXXXXXXXX \
  --record-id recXXXXXXXXXXXXXX
```

Validate fields offline against a saved schema:

```bash
node skills/airtable/airtable.cjs validate-fields \
  --schema-file /tmp/airtable-schema.json \
  --table Pipeline \
  --fields-json '{"Status":"Active","Amount":1200,"Due Date":"2026-05-31"}'
```

Create or update a record only after explicit operator grant:

```bash
node skills/airtable/airtable.cjs http-request create-record \
  --base-id appXXXXXXXXXXXXXX \
  --table tblXXXXXXXXXXXXXX \
  --fields-json '{"Name":"Acme GmbH","Status":"New"}' \
  --schema-file /tmp/airtable-schema.json \
  --operator-grant

node skills/airtable/airtable.cjs http-request update-record \
  --base-id appXXXXXXXXXXXXXX \
  --table tblXXXXXXXXXXXXXX \
  --record-id recXXXXXXXXXXXXXX \
  --fields-json '{"Status":"Closed"}' \
  --schema-file /tmp/airtable-schema.json \
  --operator-grant
```

Prepare an attachment field value:

```bash
node skills/airtable/airtable.cjs attachment-payload \
  --field Files \
  --url https://example.com/signed-contract.pdf \
  --filename signed-contract.pdf
```

Delete a record only after explicit operator grant:

```bash
node skills/airtable/airtable.cjs http-request delete-record \
  --base-id appXXXXXXXXXXXXXX \
  --table tblXXXXXXXXXXXXXX \
  --record-id recXXXXXXXXXXXXXX \
  --operator-grant
```

Run offline eval scenarios:

```bash
node skills/airtable/airtable.cjs eval-scenarios
```

## Field Validation

When table metadata is available, the helper validates common writable field
types before emitting write payloads:

- text-like fields require strings
- number, currency, percent, rating, and duration require finite numbers
- checkbox requires boolean
- date requires `YYYY-MM-DD`
- dateTime requires an ISO datetime string
- single select requires one known choice when choices are present
- multiple select requires an array of known choice strings when choices are
  present
- linked records require Airtable record id arrays
- attachments require an array of objects with `url` for new files or `id` for
  existing files; new attachment URLs must be public `http(s)` URLs and must
  not target localhost, private, or link-local IP ranges
- collaborator and barcode fields require Airtable-shaped objects

Unknown field types are allowed after schema lookup so newly introduced
Airtable types do not block read-preserving updates unnecessarily. Unknown
field names or ids are refused.

## Computed Fields

Formula, lookup, rollup, count, autonumber, created time, last modified time,
created by, and last modified by fields are read-only. Include them in record
read field selections when the user asks for computed values. Do not include
them in create or update payloads.

## Conservative Mutations

These operations require `--operator-grant`:

- `create-record`
- `update-record`
- `delete-record`
- attachment updates through `create-record` or `update-record`

Deletes are red tier. Creates, updates, and attachment updates are amber tier.
Read operations and computed-field reads are green tier.

## Working Rules

- Never print or ask for the Airtable PAT or OAuth token.
- Never use legacy API keys in new setup guidance.
- For live API calls, use `http-request` plus the built-in `http_request` tool.
- Do not claim `AIRTABLE_PAT` is missing unless `http_request` returns an
  explicit missing/forbidden/unresolved secret error.
- Fetch schema before writes when the base/table is unfamiliar.
- Treat formula, lookup, rollup, count, autonumber, and timestamp fields as
  read-only.
- Prefer record ids for writes and deletes. If a lookup returns multiple
  records, stop and ask for the exact record id.
- Use base ids that start with `app` and record ids that start with `rec`.
- Keep list calls paginated; Airtable returns at most 100 records per page.
- Respect Airtable's per-base API rate limit. Avoid loops that hammer one base.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` so evals can verify the
  accounting contract.

## References

- Airtable Web API getting started and pagination:
  https://support.airtable.com/docs/getting-started-with-airtables-web-api
- Airtable API call limits and rate limits:
  https://support.airtable.com/docs/managing-api-call-limits-in-airtable
- Airtable field types:
  https://support.airtable.com/docs/supported-field-types-in-airtable-overview
- Airtable formula and computed field behavior:
  https://support.airtable.com/docs/formula-field-reference

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/airtable
node skills/airtable/airtable.cjs --help
node skills/airtable/airtable.cjs eval-scenarios
node skills/airtable/airtable.cjs validate-fields --schema-file skills/airtable/fixtures/schema.json --table Pipeline --fields-json '{"Status":"Active","Amount":1200,"Files":[{"url":"https://example.com/file.pdf"}]}'
```
