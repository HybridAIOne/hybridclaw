---
name: lexware-office
description: "Work with Lexware Office invoices, contacts, products, receipts, payments, and accounting reports through the Lexware Public API."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: lexware-office-api-key
    kind: bearer
    required: true
    secret_ref:
      source: store
      id: LEXWARE_OFFICE_API_KEY
    scope: "https://api.lexware.io/v1"
    how_to_obtain: "Generate a private API key at https://app.lexware.de/addons/public-api, then store it with `hybridclaw secret set LEXWARE_OFFICE_API_KEY \"<api-key>\"`."
metadata:
  hybridclaw:
    category: accounting
    short_description: "Lexware Office accounting for German SMEs."
    tags:
      - accounting
      - invoices
      - lexware
      - lexoffice
      - bookkeeping
      - germany
    related_skills:
      - fastbill
      - download-platform-invoices
      - pdf
---
# Lexware Office

Use this skill when the user wants to read or manage Lexware Office invoices,
customers, products/services, expense receipts, payment status, posting
categories, or derived revenue/expense reporting.

Lexware Office was formerly known as lexoffice. Use the current Lexware Public
API gateway at `https://api.lexware.io/v1`.

## Scope

- read organization profile
- list and inspect customers/contacts
- list and inspect products/services through articles
- list invoice metadata through voucherlist
- inspect invoices and download invoice files
- list expense receipts/bookkeeping vouchers
- download bookkeeping voucher files
- inspect voucher payment status
- upload receipt files to the Belege inbox
- attach receipt files to an existing voucher
- list posting categories for bookkeeping
- derive income statement source data from voucherlist metadata and aggregate it
- extract bank-linked payment items from voucher payment responses
- create invoices
- log expense receipts as bookkeeping vouchers
- prepare a conservative transaction-match handoff

## Credential Rules

Lexware authenticates with a private API key sent as a bearer token. Store it in
HybridClaw encrypted runtime secrets; never paste it into the prompt.

Recommended setup:

```bash
hybridclaw secret set LEXWARE_OFFICE_API_KEY <lexware-office-api-key>
```

The helper builds `http_request` payloads with `bearerSecretName:
"LEXWARE_OFFICE_API_KEY"` so the gateway injects `Authorization: Bearer ...`
server-side. Secret values must not be printed, persisted, or returned to the
model.

For setup details, account-specific secret names, and API notes, read
[references/operator-setup.md](references/operator-setup.md).

## Default Workflow

1. Start with read-only operations such as `list-invoices`, `list-customers`,
   `list-products`, `list-expenses`, `payment-status`, or
   `income-statement-plan`.
2. For writes, build a dry run or exact payload first and stop unless the
   operator has granted that mutation in the current task.
3. Pass `--operator-grant` only after the user explicitly asks for the write.
4. Prefer Lexware UUIDs over names for writes. If multiple contacts, invoices,
   vouchers, or articles match, ask for the exact ID before writing.
5. Use the helper to build an `http_request` payload, then call the built-in
   `http_request` tool. Do not use shell `curl` for live calls.
6. Keep responses summarized as JSON-shaped facts; do not expose bearer tokens,
   headers, or raw secret-route diagnostics.

## Command Contract

Run the colocated helper with Node:

```bash
node skills/lexware-office/lexware_office.cjs --help
```

Plan a natural-language request without contacting Lexware:

```bash
node skills/lexware-office/lexware_office.cjs plan "Show outstanding invoices over 30 days late"
```

Build read requests:

```bash
node skills/lexware-office/lexware_office.cjs http-request list-invoices --query-json '{"voucherStatus":"open","voucherDateFrom":"2026-01-01"}'
node skills/lexware-office/lexware_office.cjs http-request list-customers --query-json '{"name":"Acme GmbH"}'
node skills/lexware-office/lexware_office.cjs http-request get-invoice --id e9066f04-8cc7-4616-93f8-ac9ecc8479c8
node skills/lexware-office/lexware_office.cjs http-request payment-status --id e9066f04-8cc7-4616-93f8-ac9ecc8479c8
node skills/lexware-office/lexware_office.cjs http-request download-file --id f9066f04-8cc7-4616-93f8-ac9ecc8479c8
```

Build a derived income statement read plan:

```bash
node skills/lexware-office/lexware_office.cjs income-statement-plan --from 2026-10-01 --to 2026-12-31
node skills/lexware-office/lexware_office.cjs aggregate-income-statement --revenue-json '{"content":[{"voucherType":"invoice","totalAmount":1190}]}' --expenses-json '{"content":[{"voucherType":"purchaseinvoice","totalAmount":357}]}'
node skills/lexware-office/lexware_office.cjs bank-transactions-from-payments --payments-json '{"id":"...","paymentItems":[{"paymentItemType":"partPaymentFinancialTransaction","amount":1190,"currency":"EUR"}]}'
```

Build write requests only after explicit operator grant:

```bash
node skills/lexware-office/lexware_office.cjs create-invoice --body-json '{"voucherDate":"2026-05-21T00:00:00.000+02:00","address":{"contactId":"..."},"lineItems":[],"totalPrice":{"currency":"EUR"},"taxConditions":{"taxType":"net"},"shippingConditions":{"shippingType":"service","shippingDate":"2026-05-21T00:00:00.000+02:00"}}' --operator-grant
node skills/lexware-office/lexware_office.cjs log-expense --body-json '{"type":"purchaseinvoice","voucherStatus":"open","voucherNumber":"EXP-2026-001","voucherDate":"2026-05-21","totalGrossAmount":119,"totalTaxAmount":19,"taxType":"gross","useCollectiveContact":true,"contactName":"Deutsche Bahn","voucherItems":[{"amount":119,"taxAmount":19,"taxRatePercent":19,"categoryId":"..."}]}' --operator-grant
node skills/lexware-office/lexware_office.cjs upload-file --file receipts/train.pdf --operator-grant
node skills/lexware-office/lexware_office.cjs attach-voucher-file --id e9066f04-8cc7-4616-93f8-ac9ecc8479c8 --file receipts/train.pdf --operator-grant
```

Prepare a manual transaction-match handoff only after explicit operator grant:

```bash
node skills/lexware-office/lexware_office.cjs match-transaction --transaction-id txn-123 --voucher-id e9066f04-8cc7-4616-93f8-ac9ecc8479c8 --operator-grant
```

Run offline eval scenarios:

```bash
node skills/lexware-office/lexware_office.cjs eval-scenarios
```

## Conservative Mutations

These actions require `--operator-grant`:

- `create-invoice`
- `log-expense`
- `upload-file`
- `attach-voucher-file`
- `match-transaction`

`match-transaction` produces a manual handoff. The Lexware Public API exposes
payment status through `/payments/{id}` and labels bank-linked payments as
`partPaymentFinancialTransaction`, but it does not expose a tenant-wide raw bank
transaction feed or transaction matching writes. Do not invent an endpoint.

## Reporting Notes

Income statement requests are derived from voucherlist source requests for
revenue and expense voucher types. Use `income-statement-plan` to produce the
source `http_request` calls, then pass the collected voucherlist responses to
`aggregate-income-statement`. Treat the result as an operational report unless
the operator confirms the exact accounting basis needed for tax, Steuerberater,
or statutory reporting.

Bank transaction reads are derived from `/payments/{voucherId}` responses. Use
`bank-transactions-from-payments` to extract `partPaymentFinancialTransaction`
items after collecting payment statuses for candidate vouchers.

Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper and eval
outputs include `costMeasurement.system = "UsageTotals"` so the accounting
contract can be verified.

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/lexware-office
node skills/lexware-office/lexware_office.cjs --help
node skills/lexware-office/lexware_office.cjs eval-scenarios
node skills/lexware-office/lexware_office.cjs http-request list-invoices
node skills/lexware-office/lexware_office.cjs income-statement-plan --from 2026-01-01 --to 2026-03-31
node skills/lexware-office/lexware_office.cjs aggregate-income-statement --revenue-json '{"content":[{"voucherType":"invoice","totalAmount":100}]}' --expenses-json '{"content":[{"voucherType":"purchaseinvoice","totalAmount":40}]}'
```
