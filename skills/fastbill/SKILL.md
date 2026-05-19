---
name: fastbill
description: "Work with FastBill invoices, customers, payments, reminders, and e-invoice exports through the FastBill XML API."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: fastbill-basic-auth
    kind: header
    required: true
    secret_ref:
      source: store
      id: FASTBILL_BASIC_AUTH
    scope: "https://my.fastbill.com/api/1.0/"
    how_to_obtain: "Base64-encode the FastBill login email and API key as email:api-key, then store it with `hybridclaw secret set FASTBILL_BASIC_AUTH \"<base64>\"`."
metadata:
  hybridclaw:
    category: accounting
    short_description: "FastBill invoicing for DACH freelancers."
    tags:
      - accounting
      - invoices
      - fastbill
      - dach
      - xrechnung
      - zugferd
    related_skills:
      - download-platform-invoices
      - pdf
---
# FastBill

Use this skill when the user wants to read or manage FastBill invoices,
customers, payment status, reminders, or e-invoice handoff data.

FastBill's classic API is a central XML/JSON web service, but this skill uses
the XML request/response path so the model can work with JSON-shaped inputs
while the helper handles XML serialization and parsing.

## Scope

- list and inspect customers
- create customers
- list and inspect invoices
- create draft invoices
- complete, cancel, lock, delete, or update invoices
- mark invoices as paid
- send completed invoices by email, including payment reminders
- fetch document metadata from the FastBill document inbox
- prepare XRechnung/ZUGFeRD export handoff information for invoices

## Credential Rules

FastBill authenticates with HTTP Basic auth using the FastBill account email and
API key. Store credentials in HybridClaw encrypted runtime secrets; never paste
the API key into the prompt.

Recommended secret route:

```text
/secret set FASTBILL_EMAIL you@example.com
/secret set FASTBILL_API_KEY <fastbill-api-key>
/secret set FASTBILL_BASIC_AUTH <base64(email:api-key)>
/secret route add https://my.fastbill.com/api/1.0/ FASTBILL_BASIC_AUTH Authorization Basic
```

Local shell setup equivalent:

```bash
hybridclaw secret set FASTBILL_EMAIL you@example.com
hybridclaw secret set FASTBILL_API_KEY <fastbill-api-key>
printf '%s:%s' "$FASTBILL_EMAIL" "$FASTBILL_API_KEY" | base64
hybridclaw secret set FASTBILL_BASIC_AUTH <base64-output>
hybridclaw secret route add https://my.fastbill.com/api/1.0/ FASTBILL_BASIC_AUTH Authorization Basic
```

This route lets the gateway inject `Authorization: Basic ...` server-side.
Secret values are not printed, persisted, or returned to the model. The helper
uses the derived `FASTBILL_BASIC_AUTH` value because Basic auth is one base64
header, while `FASTBILL_EMAIL` and `FASTBILL_API_KEY` preserve the source
credential pair in the encrypted store.

For live API calls inside HybridClaw, use the helper to build the XML-backed
`http_request` payload, then call the built-in `http_request` tool. Do not use
bash/curl for live FastBill calls: the tool has the gateway bearer token in
memory, while a bash helper process intentionally does not. Do not tell the user
to run `hybridclaw secret set HYBRIDCLAW_GATEWAY_TOKEN ...`; storing that name as
a secret does not put a bearer token into the helper environment.

The FastBill request URL is exactly
`https://my.fastbill.com/api/1.0/api.php`. The parent prefix
`https://my.fastbill.com/api/1.0/` is only for secret-route matching and should
not be used as the HTTP request URL because FastBill redirects it.

## Error Interpretation

- Gateway 401 mentioning `WEB_API_TOKEN` or `GATEWAY_API_TOKEN`: the request did
  not reach FastBill. In normal HybridClaw runtime, switch to the built-in
  `http_request` tool instead of bash/curl.
- Gateway/secret-route errors such as missing secret, forbidden secret route, or
  header injection denial: the `FASTBILL_BASIC_AUTH` secret or route is missing
  or not allowed.
- FastBill 401 with text like `Wrong API KEY or user credentials`: the gateway
  route worked and FastBill rejected the credential value. Do not say the secret
  is unconfigured. Ask the operator to regenerate `FASTBILL_BASIC_AUTH` from the
  exact FastBill login email and current API key, without pasting either value
  into chat.

## Default Workflow

1. Start with read-only commands such as `list-invoices`, `invoice.get`, or
   `customer.get`.
2. For writes, plan the exact service call and stop unless the operator has
   granted the mutation in the current task.
3. Pass `--operator-grant` only after the user explicitly asks for the write.
4. Use `--dry-run` before invoice/customer creation when the target data is
   inferred from natural language or another system.
5. Prefer invoice IDs over invoice numbers for writes.
6. For live calls, generate an `http_request` payload with the helper and send
   that payload through the built-in `http_request` tool.
7. Parse the XML response with `parse-response` if structured JSON is needed.
8. Keep FastBill responses as JSON in user-facing summaries; do not show raw XML
   unless the user asks for request debugging.

## Command Contract

Run the colocated helper with Node:

```bash
node skills/fastbill/fastbill.cjs --help
```

Plan a natural-language request without contacting FastBill:

```bash
node skills/fastbill/fastbill.cjs plan "Show unpaid invoices older than 30 days"
```

Build the payload for a live FastBill service call, then call the built-in
`http_request` tool with the returned `httpRequest` object:

```bash
node skills/fastbill/fastbill.cjs http-request invoice.get --filter-json '{"INVOICE_ID":"123"}'
node skills/fastbill/fastbill.cjs http-request customer.create --data-json '{"CUSTOMER_TYPE":"business","ORGANIZATION":"Acme GmbH","COUNTRY_CODE":"DE"}' --operator-grant
```

Parse a saved `http_request` response body or wrapper:

```bash
node skills/fastbill/fastbill.cjs parse-response --body-file /tmp/fastbill-response.json
```

Direct helper network calls are only for operator-controlled local shell tests
where the gateway token is already exported in the process environment:

```bash
node skills/fastbill/fastbill.cjs request invoice.get --filter-json '{"INVOICE_ID":"123"}'
```

For invoice listing inside HybridClaw, build the read request and send it with
the built-in `http_request` tool. Apply state filtering after parsing the
response:

```bash
node skills/fastbill/fastbill.cjs http-request invoice.get --filter-json '{"END_DUE_DATE":"2026-04-08"}' --limit 100
```

For writes inside HybridClaw, build the request payload only after explicit
operator grant, then send the returned `httpRequest` object with the built-in
`http_request` tool:

```bash
node skills/fastbill/fastbill.cjs http-request invoice.create --data-json '{"CUSTOMER_ID":"123","ITEMS":{"ITEM":[{"DESCRIPTION":"Consulting","QUANTITY":"8","UNIT_PRICE":"120.00","VAT_PERCENT":"19"}]}}' --operator-grant
node skills/fastbill/fastbill.cjs http-request invoice.setpaid --data-json '{"INVOICE_ID":"456","PAID_DATE":"2026-05-07","PAYMENT_METHOD":"bank transfer"}' --operator-grant
node skills/fastbill/fastbill.cjs http-request invoice.sendbyemail --data-json '{"INVOICE_ID":"456","RECIPIENT":{"TO":"billing@example.com"},"SUBJECT":"Payment reminder","MESSAGE":"Please review the outstanding invoice and payment status."}' --operator-grant
```

The direct convenience commands `list-invoices`, `create-invoice`,
`mark-paid`, `send-reminder`, and `export-einvoice` perform their own gateway
network call. Use them only in operator-controlled local shell tests where a
valid gateway token is already exported in the process environment.

Run offline eval scenarios:

```bash
node skills/fastbill/fastbill.cjs eval-scenarios
```

## Conservative Mutations

These services require `--operator-grant`:

- `customer.create`, `customer.update`, `customer.delete`
- `contact.create`, `contact.update`, `contact.delete`
- `invoice.create`, `invoice.update`, `invoice.delete`
- `invoice.complete`, `invoice.cancel`, `invoice.lock`
- `invoice.sendbyemail`, `invoice.sendbypost`, `invoice.setpaid`
- `estimate.create`, `estimate.delete`, `estimate.sendbyemail`, `estimate.createinvoice`
- `article.create`, `article.update`, `article.delete`
- `recurring.create`, `recurring.update`, `recurring.delete`
- `revenue.create`, `revenue.setpaid`, `revenue.delete`
- `expense.create`, `project.create`, `project.update`, `project.delete`
- `time.create`, `time.update`, `time.delete`
- `document.create`, `webhook.create`, `webhook.delete`

Read services run at default autonomy.

## E-Invoice Notes

FastBill can create and send XRechnung and ZUGFeRD invoices when e-invoicing is
enabled in the account and mandatory buyer/seller fields are complete. For
XRechnung handoff, verify customer email, phone, buyer reference/Leitweg-ID,
address, country, VAT ID, and bank data before finalizing an invoice.

The local readiness fixture at `fixtures/einvoice-readiness.json` records the
FastBill-side fields the eval suite checks before handoff to a downstream
XRechnung/ZUGFeRD validator.

The helper does not claim conformance by itself. Pair exported invoice metadata
or downloaded invoice documents with the XRechnung/ZUGFeRD validation workflow
before sending to public-sector or mandate-bound B2B recipients.

## Working Rules

- Never print or ask for the FastBill API key.
- Never build a Basic header in a prompt. Use the configured secret route.
- For live API calls, use `http-request` plus the built-in `http_request` tool;
  do not ask the user to store a gateway bearer token as a secret.
- If FastBill says `Wrong API KEY or user credentials`, report that FastBill
  rejected the stored Basic credential; do not call it a missing secret.
- Keep XML local to the helper; expose JSON-shaped request and response data.
- Treat `invoice.create`, `customer.create`, `invoice.setpaid`, and reminder email sends as operator-granted writes.
- Use `--dry-run` when translating time tracking, CSV, or free text into invoice line items.
- When multiple invoices or customers match a lookup, stop and ask for the exact ID before writing.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output includes `costMeasurement.system = "UsageTotals"` so evals can verify the accounting contract.

## References

- Operator setup and FastBill API notes: [references/operator-setup.md](references/operator-setup.md)

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/fastbill
node skills/fastbill/fastbill.cjs --help
node skills/fastbill/fastbill.cjs eval-scenarios
node skills/fastbill/fastbill.cjs http-request invoice.get --filter-json '{"INVOICE_ID":"123"}'
node skills/fastbill/fastbill.cjs request invoice.get --filter-json '{"INVOICE_ID":"123"}' --dry-run
```
