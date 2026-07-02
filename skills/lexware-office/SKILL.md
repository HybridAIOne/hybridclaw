---
name: lexware-office
description: "Work with Lexware Office contacts, products, invoices, quotations, bookkeeping vouchers, receipts, payment status, and guarded invoice, quotation, or expense writes through the Public API."
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
    scope: "https://api.lexware.io/"
    how_to_obtain: "Create a Lexware Office Public API key at https://app.lexware.de/addons/public-api, then store it with `hybridclaw secret set LEXWARE_OFFICE_API_KEY \"<api-key>\"`."
metadata:
  hybridclaw:
    category: accounting
    short_description: "Lexware Office invoices, quotations, contacts, vouchers, receipts, and payment status."
    tags:
      - accounting
      - invoices
      - quotations
      - lexware
      - lexoffice
      - receipts
      - dach
    related_skills:
      - fastbill
      - download-platform-invoices
      - pdf
    stakes_tiers:
      green:
        - contact-read
        - product-read
        - invoice-read
        - quotation-read
        - voucher-read
        - payment-read
        - reporting-plan
      amber:
        - contact-create
        - invoice-create
        - quotation-create
        - expense-log
        - voucher-update
        - receipt-upload
        - transaction-match-plan
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_contract: R5.4
      sub_limit_key: lexware-office
---

# Lexware Office

Use this skill when the user wants to inspect or manage Lexware Office data for
German SME accounting workflows: customers, products/articles, invoices,
quotations, bookkeeping vouchers, receipt files, posting categories, payment
status, and high-level revenue or income-statement summaries.

Lexware Office was formerly branded lexoffice. This skill uses the current
Public API gateway at `https://api.lexware.io`.

## Scope

- read contacts/customers
- read articles/products/services used in invoice line items
- list invoices through `voucherlist` and retrieve invoice details
- download invoice files from the invoice file subresource
- list quotations through `voucherlist`, retrieve quotation details, and
  download quotation PDF files from the quotation file subresource
- list and retrieve bookkeeping vouchers, including purchase invoices and
  receipt records
- read payment status and payment items for vouchers through `/v1/payments`
- read bank-linked payment items by scanning voucher payments for
  `partPaymentFinancialTransaction`
- read posting categories for revenue and expense classification
- prepare local revenue and income-statement aggregation plans from voucherlist
  and posting-category reads
- aggregate fetched voucher pages into revenue summaries and income statements
- create contacts only after explicit operator grant
- create draft or finalized invoices only after explicit operator grant
- create draft or finalized quotations only after explicit operator grant
- log expense vouchers and upload receipt files only after explicit operator
  grant
- match incoming bank transactions against open invoices locally, then prepare
  a granted voucher reconciliation-note update through the documented voucher
  `PUT` endpoint
- update vouchers only after reading the current `version` and receiving
  explicit operator grant

## Credential Rules

Lexware Office authenticates with a bearer API key. Store the API key in
HybridClaw encrypted runtime secrets; never paste it into the prompt.

Recommended setup:

```bash
hybridclaw secret set LEXWARE_OFFICE_API_KEY "<api-key>"
```

For live API calls inside HybridClaw, run the helper to build an `http_request`
payload wrapper, then pass only the emitted `httpRequest` object to the built-in
`http_request` tool. The helper sets
`bearerSecretName: "LEXWARE_OFFICE_API_KEY"` so the gateway injects the bearer
token server-side.

Do not verify the key with bash/curl. The model cannot inspect the gateway
secret store, and shell commands intentionally should not receive runtime API
keys. Only say the secret is missing if the `http_request` tool returns a
gateway error that explicitly says `LEXWARE_OFFICE_API_KEY` cannot be resolved.

## Error Interpretation

- Gateway errors saying `LEXWARE_OFFICE_API_KEY` is missing or unresolved: ask
  the operator to store the key in the active HybridClaw runtime and restart any
  already-running gateway if needed.
- Gateway errors saying the secret is blocked by policy: report a
  policy/runtime configuration problem, not a missing API key.
- Lexware `401` or `403`: the gateway injected a token, but Lexware rejected it
  or the account lacks Public API access. Ask the operator to regenerate the key
  and verify the Lexware Office plan/API add-on.
- Lexware `429`: back off; Lexware documents a 2-request-per-second resource
  endpoint limit.
- Lexware optimistic-locking errors on voucher updates: read the voucher again
  and retry only after the user confirms the current version should be changed.

## Default Workflow

1. Start with read-only commands: `profile`, `list-contacts`,
   `list-invoices`, `list-expenses`, `get-payment`, `list-bank-transactions`,
   or `posting-categories`.
2. Use `plan` for natural-language requests when the action tier is unclear.
3. For writes, stop unless the operator has granted that exact mutation in the
   current task.
4. Pass `--operator-grant` only after explicit approval or an approved F14
   escalation.
5. Create invoices as drafts unless the user explicitly asks to finalize/send.
6. Create quotations as drafts unless the user explicitly asks to finalize or
   issue the quotation. Lexware finalizes quotations at creation with
   `finalize=true`; its public docs say quotation status cannot be changed
   later through the API.
7. Only send documents or finalize documents when it is clear the user wants
   that. If intent is ambiguous, ask whether to keep a draft or produce the
   final document. The current helper does not expose a Lexware send command,
   so never claim that a document was sent through Lexware.
8. Before voucher updates, fetch the current voucher and include its `version`
   property in the write payload.
9. For income-statement or revenue questions, use `income-statement-plan` or
   `revenue-summary-plan`, execute the returned read requests, then run
   `income-statement` or `revenue-summary` on the saved JSON responses.
10. For bank-transaction matching, use `list-bank-transactions` and
   `match-transaction` to score candidate invoices. Lexware Public API exposes
   payment status and bank-linked payment items but no documented direct bank
   assignment mutation, so the write path records an operator-approved
   reconciliation note on the voucher via documented voucher update.

## Command Contract

Run the colocated helper with Node:

```bash
node skills/lexware-office/lexware_office.cjs --help
```

Plan a natural-language request without contacting Lexware:

```bash
node skills/lexware-office/lexware_office.cjs plan "Pull outstanding invoices and chase any over 30 days late"
```

Build read requests:

```bash
node skills/lexware-office/lexware_office.cjs http-request profile
node skills/lexware-office/lexware_office.cjs http-request list-contacts --name Acme --size 10
node skills/lexware-office/lexware_office.cjs http-request list-products --type SERVICE
node skills/lexware-office/lexware_office.cjs http-request list-invoices --status open --size 25
node skills/lexware-office/lexware_office.cjs http-request get-invoice --id 11111111-1111-4111-8111-111111111111
node skills/lexware-office/lexware_office.cjs http-request list-quotations --status open --size 25
node skills/lexware-office/lexware_office.cjs http-request get-quotation --id 11111111-1111-4111-8111-111111111111
node skills/lexware-office/lexware_office.cjs http-request download-quotation-file --id 11111111-1111-4111-8111-111111111111
node skills/lexware-office/lexware_office.cjs http-request render-quotation-document --id 11111111-1111-4111-8111-111111111111
node skills/lexware-office/lexware_office.cjs http-request list-expenses --status open --start-date 2026-01-01 --end-date 2026-03-31
node skills/lexware-office/lexware_office.cjs http-request get-payment --voucher-id 11111111-1111-4111-8111-111111111111
node skills/lexware-office/lexware_office.cjs http-request list-bank-transactions --status paid
node skills/lexware-office/lexware_office.cjs http-request posting-categories
node skills/lexware-office/lexware_office.cjs http-request income-statement-plan --start-date 2026-10-01 --end-date 2026-12-31
node skills/lexware-office/lexware_office.cjs income-statement --revenue-file /tmp/lexware-revenue.json --expense-file /tmp/lexware-expenses.json --start-date 2026-10-01 --end-date 2026-12-31
node skills/lexware-office/lexware_office.cjs revenue-summary --revenue-file /tmp/lexware-revenue.json
node skills/lexware-office/lexware_office.cjs match-transaction --transaction-json '{"id":"tx-1","amount":119,"purpose":"Invoice 2026-042 Acme GmbH"}' --invoices-file /tmp/lexware-open-invoices.json
```

Build write requests only after explicit operator grant:

```bash
node skills/lexware-office/lexware_office.cjs http-request create-contact \
  --json '{"roles":{"customer":{}},"company":{"name":"Acme GmbH"},"addresses":{"billing":[{"street":"Example Str. 1","zip":"10115","city":"Berlin","countryCode":"DE"}]}}' \
  --operator-grant

node skills/lexware-office/lexware_office.cjs http-request create-invoice \
  --json '{"voucherDate":"2026-05-21T00:00:00.000+02:00","address":{"name":"Acme GmbH","street":"Example Str. 1","zip":"10115","city":"Berlin","countryCode":"DE"},"lineItems":[{"type":"custom","name":"Consulting","quantity":8,"unitName":"hours","unitPrice":{"currency":"EUR","netAmount":120,"taxRatePercentage":19}}],"totalPrice":{"currency":"EUR"},"taxConditions":{"taxType":"net"},"paymentConditions":{"paymentTermLabel":"Due in 14 days","paymentTermDuration":14}}' \
  --operator-grant

node skills/lexware-office/lexware_office.cjs http-request create-quotation \
  --json '{"voucherDate":"2026-05-21T00:00:00.000+02:00","expirationDate":"2026-06-20T00:00:00.000+02:00","address":{"name":"Acme GmbH","street":"Example Str. 1","zip":"10115","city":"Berlin","countryCode":"DE"},"lineItems":[{"type":"custom","name":"Consulting","quantity":8,"unitName":"hours","unitPrice":{"currency":"EUR","netAmount":120,"taxRatePercentage":19}}],"totalPrice":{"currency":"EUR"},"taxConditions":{"taxType":"net"}}' \
  --operator-grant

node skills/lexware-office/lexware_office.cjs http-request log-expense \
  --json '{"type":"purchaseinvoice","voucherDate":"2026-05-21T00:00:00.000+02:00","totalGrossAmount":119,"taxType":"gross","voucherItems":[{"amount":119,"taxAmount":19,"taxRatePercent":19,"categoryId":"cf03a2b0-f838-474f-ac5e-67adb9b830c7"}]}' \
  --operator-grant

node skills/lexware-office/lexware_office.cjs http-request match-transaction \
  --voucher-id 11111111-1111-4111-8111-111111111111 \
  --voucher-json '{"type":"salesinvoice","voucherNumber":"2026-042","version":3,"remark":"Reviewed"}' \
  --transaction-json '{"id":"tx-1","amount":119,"bookingDate":"2026-05-21","counterpartyName":"Acme GmbH"}' \
  --operator-grant
```

Upload a receipt file:

```bash
node skills/lexware-office/lexware_office.cjs http-request upload-file --file /workspace/receipt.pdf --type voucher --operator-grant
node skills/lexware-office/lexware_office.cjs http-request attach-file-to-voucher --voucher-id 11111111-1111-4111-8111-111111111111 --file /workspace/receipt.pdf --operator-grant
```

Run offline eval scenarios:

```bash
node skills/lexware-office/lexware_office.cjs eval-scenarios
```

## Conservative Mutations

These helper operations require `--operator-grant`:

- `create-contact`
- `create-invoice`
- `create-quotation`
- `log-expense`
- `upload-file`
- `attach-file-to-voucher`
- `update-voucher`
- `match-transaction`

`match-transaction` is intentionally conservative: it does not claim to assign
the bank transaction inside Lexware's banking module, because the Public API
does not document that mutation. It writes an auditable reconciliation note to
the voucher after explicit operator grant.

## Working Rules

- Never print or ask for the Lexware Office API key.
- Never build an Authorization header manually in a prompt. Use
  `bearerSecretName: "LEXWARE_OFFICE_API_KEY"`.
- Prefer helper-emitted `httpRequest` payloads over handcrafted API calls.
- Read before write when IDs, versions, posting categories, contact IDs, or
  invoice recipient details are ambiguous.
- If multiple contacts or invoices match, stop and ask for the exact ID before
  writing.
- Default invoice creation to draft. Use `--finalize` only after explicit user
  instruction.
- Default quotation creation to draft. Use `--finalize` only after explicit
  user instruction to issue/finalize the quotation, and ask when the wording is
  ambiguous.
- Prefer `download-quotation-file` for quotation PDFs. Use the deprecated
  `render-quotation-document` endpoint only when the user specifically needs a
  document file id for an older workflow.
- Treat receipt uploads and voucher changes as account-data mutations.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` so evals can verify the
  accounting contract.

## References

- Operator setup: [references/operator-setup.md](references/operator-setup.md)
- Lexware Public API docs: https://developers.lexware.io/docs/

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/lexware-office
node skills/lexware-office/lexware_office.cjs --help
node skills/lexware-office/lexware_office.cjs eval-scenarios
node skills/lexware-office/lexware_office.cjs http-request list-invoices --status open
node skills/lexware-office/lexware_office.cjs http-request list-quotations --status open
node skills/lexware-office/lexware_office.cjs http-request list-bank-transactions --status paid
node skills/lexware-office/lexware_office.cjs http-request create-invoice --json '{"voucherDate":"2026-05-21T00:00:00.000+02:00"}'
node skills/lexware-office/lexware_office.cjs http-request create-quotation --json '{"voucherDate":"2026-05-21T00:00:00.000+02:00"}'
```
