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
    how_to_obtain: "Base64-encode the FastBill login email and API key as email:api-key. Set `FASTBILL_BASIC_AUTH` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set FASTBILL_BASIC_AUTH \"<base64>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set FASTBILL_BASIC_AUTH \"<base64>\"`."
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

Use this skill for FastBill invoices, customers, payments, reminders, and
document metadata. The helper wraps concrete FastBill API services: it
serializes JSON-shaped inputs to XML and parses XML responses.

## Core Rules

- Use the helper plus built-in `http_request` for live API calls. Do not use
  `curl`, ad hoc `node -e`, `grep`, or shell parsing for FastBill.
- FastBill API URL: `https://my.fastbill.com/api/1.0/api.php`.
  The `/api/1.0/` prefix is only for secret-route matching.
- Basic auth is injected by the gateway from `FASTBILL_BASIC_AUTH`. Never print,
  build, or ask for the FastBill API key.
- Writes require explicit operator intent and `--operator-grant`. Prefer
  `--dry-run` when converting free text, CSV, or time tracking into invoice data.
- Prefer invoice IDs for writes. If multiple invoices/customers match, ask for
  the exact ID before writing.
- If unsure about a service or field, check `https://apidocs.fastbill.com`.

## Commands

Show commands:

```bash
node skills/fastbill/fastbill.cjs --help
```

Build an `http_request` payload for the built-in `http_request` tool:

```bash
node skills/fastbill/fastbill.cjs http-request invoice.get --filter-json '{"INVOICE_ID":"123"}'
node skills/fastbill/fastbill.cjs http-request customer.create --data-json '{"CUSTOMER_TYPE":"business","ORGANIZATION":"Acme GmbH","COUNTRY_CODE":"DE"}' --operator-grant
```

Parse a saved `http_request` response wrapper/body:

```bash
node skills/fastbill/fastbill.cjs parse-response --body-file /tmp/fastbill-response.json
```

Direct helper network calls are only for operator-controlled shell tests with a
valid gateway token already exported:

```bash
node skills/fastbill/fastbill.cjs request invoice.get --filter-json '{"INVOICE_ID":"123"}'
```

Common invoice payloads:

```bash
node skills/fastbill/fastbill.cjs http-request invoice.get --filter-json '{"END_DUE_DATE":"2026-04-08"}' --limit 100
node skills/fastbill/fastbill.cjs http-request invoice.create --data-json '{"CUSTOMER_ID":"123","INVOICE_TITLE":"Consulting Januar - Juni 2026","ITEMS":{"ITEM":[{"DESCRIPTION":"Consulting","QUANTITY":"8","UNIT_PRICE":"120.00","VAT_PERCENT":"19"}]}}' --operator-grant
node skills/fastbill/fastbill.cjs http-request invoice.update --data-json '{"INVOICE_ID":"456","INVOICE_TITLE":"YouGov SVOD Januar - Juni 2026"}' --operator-grant
node skills/fastbill/fastbill.cjs http-request invoice.setpaid --data-json '{"INVOICE_ID":"456","PAID_DATE":"2026-05-07","PAYMENT_METHOD":"bank transfer"}' --operator-grant
node skills/fastbill/fastbill.cjs http-request invoice.sendbyemail --data-json '{"INVOICE_ID":"456","RECIPIENT":{"TO":"billing@example.com"},"SUBJECT":"Payment reminder","MESSAGE":"Please review the outstanding invoice and payment status."}' --operator-grant
```

## Clone / Copy Invoice

FastBill's API does not expose a dedicated invoice clone/copy service, even
though the UI has one. Implement clone as `invoice.get` then `invoice.create`.

1. Use one targeted `invoice.get`; prefer date, customer/project text, title,
   and service-period terms over broad account-wide searches.
2. Select one source invoice. If ambiguous, ask for the invoice ID.
3. Copy relevant source fields: `CUSTOMER_ID`, `CUSTOMER_COSTCENTER_ID`,
   `CONTACT_ID`, `CURRENCY_CODE`, `TEMPLATE_ID`/`TEMPLATE_HASH`, `INTROTEXT`,
   `INVOICE_TITLE`, references, discounts, VAT settings, and `ITEMS`.
4. Omit lifecycle/source fields: `INVOICE_ID`, `INVOICE_NUMBER`, `STATE`,
   `PAID_DATE`, `PAYMENTS`, `DOCUMENT_URL`, `DETAILS_URL`, totals, and
   cancellation flags.
5. Apply requested changes, then create the draft with
   `invoice.create --operator-grant`. Extra reads need a concrete missing field.

## Invoice Title Fields

- Invoice title field: `INVOICE_TITLE` in `invoice.create` and
  `invoice.update`. Do not use `TITLE`, `NAME`, or `SUBJECT`.
- Existing draft title edit: `invoice.update` with `INVOICE_ID` and
  `INVOICE_TITLE`.
- `INTROTEXT` is intro/body text before line items.
- `ITEMS.ITEM[].DESCRIPTION` is line-item text.
- `SUBJECT` is only for email actions such as `invoice.sendbyemail`.
- Do not set `INVOICE_NUMBER` when creating or editing a draft title.

## Write Services

These require `--operator-grant`: `customer.create/update/delete`,
`contact.create/update/delete`, `invoice.create/update/delete/complete/cancel/lock/sendbyemail/sendbypost/setpaid`,
`estimate.create/delete/sendbyemail/createinvoice`, `article.create/update/delete`,
`recurring.create/update/delete`, `revenue.create/setpaid/delete`,
`expense.create`, `project.create/update/delete`, `time.create/update/delete`,
and `document.create`, `webhook.create/delete`.

## Errors

- Gateway 401 mentioning `WEB_API_TOKEN` or `GATEWAY_API_TOKEN`: the request did
  not reach FastBill; use built-in `http_request` in normal runtime.
- Missing/forbidden secret route: fix `FASTBILL_BASIC_AUTH` or its route.
- FastBill 401 with `Wrong API KEY` / credentials: the route worked, but
  FastBill rejected the stored Basic credential.

## References

- Operator setup and API notes: [references/operator-setup.md](references/operator-setup.md)

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/fastbill
node skills/fastbill/fastbill.cjs --help
node skills/fastbill/fastbill.cjs http-request invoice.get --filter-json '{"INVOICE_ID":"123"}'
node skills/fastbill/fastbill.cjs request invoice.get --filter-json '{"INVOICE_ID":"123"}' --dry-run
```
