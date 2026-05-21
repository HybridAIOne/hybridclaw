---
name: fax-send
description: "Send outbound PDF faxes through a guarded provider adapter and route inbound fax-to-email PDFs into downstream document workflows."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: sinch-fax-basic-auth
    kind: header
    required: false
    secret_ref:
      source: store
      id: SINCH_FAX_BASIC_AUTH
    scope: "fax.api.sinch.com"
    how_to_obtain: "Create Sinch Fax API credentials for the target EU project/service, base64-encode username:password, and store the value with `hybridclaw secret set SINCH_FAX_BASIC_AUTH \"<base64>\"`."
  - id: sinch-fax-oauth-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: SINCH_FAX_OAUTH_TOKEN
    scope: "fax.api.sinch.com"
    how_to_obtain: "Use only when the operator has an OAuth token minting path for Sinch Fax; store the current bearer token as `SINCH_FAX_OAUTH_TOKEN`."
metadata:
  hybridclaw:
    category: communication
    short_description: "Guarded outbound fax sending for DACH PDF workflows."
    tags:
      - fax
      - dach
      - pdf
      - sinch
      - healthcare
      - legal
      - steuerberater
    related_roadmap:
      - R26
    issue: 659
    stakes_tiers:
      green:
        - fax.status
        - fax.classify-status
        - fax.plan
      amber:
        - fax.send
    escalation:
      writes: confirm-each
      route: f8
    cost_measurement:
      system: UsageTotals
      sub_limit_key: fax-pages
      unit: fax-page
---

# Fax Send

Use this skill when a user asks to fax a supported file, web page, text note, or
PDF to an external fax number, or when an inbound fax arrives as an email PDF
and needs routing to a document workflow such as DATEV Belegtransfer, file
storage, or client records.

## Response Contract

- Return exactly one user-facing summary per fax request. Do not restate the
  same plan, missing-input list, or no-send notice in a second format.
- Do not use decorative emoji, checkmarks, sign-off text, or "ready to proceed"
  filler in fax responses.
- When the user provides text content such as "Hallo Welt", use the helper's
  direct text-file upload path after the sender fax number, Sinch project ID,
  Sinch service ID, stored credential, and explicit approval are available.

## Scope

- outbound fax send from a content URL or direct plain-text file upload
- Sinch Fax API request construction for EU-resident Sinch projects/services
- delivery status lookup and status-to-audit-event classification
- structured audit persistence through `src/fax/accounting.ts`
- fax-page usage accounting through HybridClaw `UsageTotals`
- inbound fax-to-email operating recipe through the existing email channel
- eval scenarios for successful send, busy/retry, failed delivery, and inbound
  PDF handoff flows

Direct modem control, T.38/SIP live transmission, binary local file upload, and
cover-page templating are outside this skill slice.

## Credential Rules

Store credentials in HybridClaw encrypted runtime secrets. Never paste them into
chat or helper arguments.

For Sinch Basic auth, store the base64 value of `username:password`:

```bash
hybridclaw secret set SINCH_FAX_BASIC_AUTH "<base64-username-password>"
```

For Sinch OAuth, store a bearer token only if the operator has a token minting
process:

```bash
hybridclaw secret set SINCH_FAX_OAUTH_TOKEN "<access-token>"
```

The helper emits either `secretHeaders: [{ name: "Authorization", secretName:
"SINCH_FAX_BASIC_AUTH", prefix: "Basic" }]` or `bearerSecretName:
"SINCH_FAX_OAUTH_TOKEN"` so the gateway injects the secret server-side.

## Default Workflow

1. Confirm the recipient fax number in E.164 format, the content URL or text
   upload content, the sender fax number, and the provider/project/service.
2. Run `plan` for natural-language requests when details are incomplete.
3. Require explicit operator approval before `fax.send`; faxing is an external
   document delivery action and can incur per-page cost.
4. Build the request with `fax_send.cjs http-request send`. Do not hand-author
   Sinch API JSON or secret references.
5. Pass only the emitted `httpRequest` object to `http_request` for live sends.
6. Record/inspect audit intent or call the runtime accounting helper:
   - `fax.send.start` before dispatch
   - `fax.send.delivered` when status is `COMPLETED`
   - `fax.send.failed` when status is `FAILURE`
7. Use `classify-status` after status polling or webhook payloads to turn
   provider states into the expected audit event and retry decision.

## Command Contract

Run the helper:

```bash
node skills/fax-send/fax_send.cjs --help
```

Plan a request without contacting a provider:

```bash
node skills/fax-send/fax_send.cjs --format json plan "Fax the signed contract to +49 89 1234567"
```

Build a guarded Sinch outbound request:

```bash
node skills/fax-send/fax_send.cjs --format json http-request send \
  --provider sinch \
  --auth basic \
  --project-id <sinch-project-id> \
  --service-id <sinch-service-id> \
  --content-url https://example.com/signed-contract.pdf \
  --to +49891234567 \
  --from +493012345678 \
  --page-count 3 \
  --label costCenter=legal \
  --operator-grant
```

Look up delivery status:

```bash
node skills/fax-send/fax_send.cjs --format json http-request status \
  --project-id <sinch-project-id> \
  --fax-id 01F3J0G1M4WQR6HGY6HCF6JA0K
```

Classify a provider status into audit and retry handling:

```bash
node skills/fax-send/fax_send.cjs --format json classify-status \
  --fax-id 01F3J0G1M4WQR6HGY6HCF6JA0K \
  --provider sinch \
  --status FAILURE \
  --error-type CALL_ERROR \
  --error-message "BUSY"
```

List provider reference support:

```bash
node skills/fax-send/fax_send.cjs --format json providers
```

List eval scenarios:

```bash
node skills/fax-send/fax_send.cjs --format json eval-scenarios
```

## Inbound Fax-To-Email

Inbound fax is handled by the existing email channel. Configure the fax provider
or telco portal to forward inbound faxes as PDF attachments to a dedicated
mailbox, then configure HybridClaw email polling for that mailbox.

Use a narrow sender allowlist when the provider uses stable sender domains, and
route attachment PDFs with normal document skills. See
`docs/content/channels/fax.md` for the operator recipe and reference YAML.

Build a guarded Sinch text-file upload request:

```bash
node skills/fax-send/fax_send.cjs --format json http-request send \
  --provider sinch \
  --auth basic \
  --project-id <sinch-project-id> \
  --service-id <sinch-service-id> \
  --text "Hallo Welt" \
  --filename hallo-welt.txt \
  --to +498920931098 \
  --from +493012345678 \
  --page-count 1 \
  --operator-grant
```

## Working Rules

- For URL-based sends, use a public HTTP(S) `contentUrl` for a Sinch-supported
  file type or web page. Do not send local paths or private intranet URLs to a
  fax provider.
- For short user-provided text, use `--text` so the helper emits a
  secret-backed multipart/form-data request with a direct `.txt` file upload.
- For `plan` responses, give one concise no-send summary only. Do not repeat
  the same plan in a second format, do not mirror raw helper JSON after a
  human summary, and do not add decorative emoji, sign-off text, or readiness
  filler.
- Normalize German numbers to E.164 before dispatch, for example
  `+49 89 1234567` becomes `+49891234567`.
- Treat `SUPERFINE` as higher cost/risk than the default `FINE`; use it only
  when the user needs small text or detailed scans.
- Preserve provider fax IDs in all handoffs and audit notes.
- If a live send returns 401 or 403, stop after the first failure and ask the
  operator to verify the stored Sinch credential.
- If delivery fails with a line/busy/call error and retries remain, report the
  retry plan instead of resending manually in parallel.
- Cost per fax is page-based. Helper output includes
  `costMeasurement.system = "UsageTotals"` plus `unit = "fax-page"` and the
  provided `pageCount` so evals can verify the accounting contract.
- Runtime integrations should call `recordFaxUsageEvent()` after provider
  acceptance or final delivery so `UsageTotals.billable_units` includes
  `fax-page` quantity and provider cost.
- Runtime integrations should call `recordFaxSendStart()`,
  `recordFaxSendDelivered()`, and `recordFaxSendFailed()` from
  `src/fax/accounting.ts` so the structured audit table contains real
  `fax.send.*` rows with provider message IDs.
