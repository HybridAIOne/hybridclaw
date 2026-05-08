---
name: fastbill
description: "Work with FastBill invoices, customers, payments, reminders, and e-invoice exports through the FastBill XML API."
user-invocable: true
requires:
  bins:
    - node
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

This route lets the gateway inject `Authorization: Basic ...` server-side. The
helper sends XML through `/api/http/request`; secret values are not printed,
persisted, or returned to the model. The helper uses the derived
`FASTBILL_BASIC_AUTH` value because Basic auth is one base64 header, while
`FASTBILL_EMAIL` and `FASTBILL_API_KEY` preserve the source credential pair in
the encrypted store.

The helper also has to authenticate to the local HybridClaw gateway before it can
call `/api/http/request`. In local shell tests, provide a gateway token through
`HYBRIDCLAW_GATEWAY_TOKEN`, `GATEWAY_API_TOKEN`, or `WEB_API_TOKEN`; do not paste
that token into the prompt.
If the helper returns `FASTBILL_CONFIG_ERROR` saying gateway proxy authentication
failed, stop. Do not inspect environment variables, print logs, or tell the user
to recreate FastBill credentials. Report that the helper process is missing a
gateway token and that FastBill was not contacted.

## Default Workflow

1. Start with read-only commands such as `list-invoices`, `invoice.get`, or
   `customer.get`.
2. For writes, plan the exact service call and stop unless the operator has
   granted the mutation in the current task.
3. Pass `--operator-grant` only after the user explicitly asks for the write.
4. Use `--dry-run` before invoice/customer creation when the target data is
   inferred from natural language or another system.
5. Prefer invoice IDs over invoice numbers for writes.
6. Keep FastBill responses as JSON in user-facing summaries; do not show raw XML
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

Send an arbitrary supported FastBill service call:

```bash
node skills/fastbill/fastbill.cjs request invoice.get --filter-json '{"INVOICE_ID":"123"}'
node skills/fastbill/fastbill.cjs request customer.create --data-json '{"CUSTOMER_TYPE":"business","ORGANIZATION":"Acme GmbH","COUNTRY_CODE":"DE"}' --operator-grant
```

List unpaid or overdue invoices:

```bash
node skills/fastbill/fastbill.cjs list-invoices --state overdue --older-than-days 30
```

Create an invoice from JSON:

```bash
node skills/fastbill/fastbill.cjs create-invoice --data-json '{"CUSTOMER_ID":"123","ITEMS":{"ITEM":[{"DESCRIPTION":"Consulting","QUANTITY":"8","UNIT_PRICE":"120.00","VAT_PERCENT":"19"}]}}' --operator-grant
```

Mark an invoice as paid:

```bash
node skills/fastbill/fastbill.cjs mark-paid --invoice-id 456 --paid-date 2026-05-07 --payment-method "bank transfer" --operator-grant
```

Send a payment reminder by email:

```bash
node skills/fastbill/fastbill.cjs send-reminder --invoice-id 456 --recipient billing@example.com --operator-grant
```

Prepare e-invoice export handoff data:

```bash
node skills/fastbill/fastbill.cjs export-einvoice --invoice-id 456
```

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
- On gateway proxy authentication failures, stop and report the missing
  gateway-token wiring; do not search env/logs or diagnose FastBill credentials.
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
node skills/fastbill/fastbill.cjs request invoice.get --filter-json '{"INVOICE_ID":"123"}' --dry-run
```
