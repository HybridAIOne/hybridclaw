# FastBill Operator Setup

## API Endpoint

The classic FastBill API uses a central service URL:

```text
https://my.fastbill.com/api/1.0/api.php
```

Requests are POST requests with an XML body containing `FBAPI`, `SERVICE`,
`FILTER`, and/or `DATA` elements.

## Authentication

FastBill classic API authentication uses HTTP Basic auth with the account email
address as the username and the account API key as the password. API access is
stateless, so the credentials are submitted for every request.

Store the Basic credential as a HybridClaw runtime secret:

```bash
hybridclaw secret set FASTBILL_EMAIL you@example.com
hybridclaw secret set FASTBILL_API_KEY <fastbill-api-key>
printf '%s:%s' "$FASTBILL_EMAIL" "$FASTBILL_API_KEY" | base64
hybridclaw secret set FASTBILL_BASIC_AUTH <base64-output>
hybridclaw secret route add https://my.fastbill.com/api/1.0/api.php FASTBILL_BASIC_AUTH Authorization Basic
```

The helper uses only the derived `FASTBILL_BASIC_AUTH` route because HTTP Basic
auth requires `base64(email:api-key)` as one header value. Keeping
`FASTBILL_EMAIL` and `FASTBILL_API_KEY` as stored secrets records the source
credential pair without exposing either value to the model.

Do not paste the API key into the model context. If a user provides it in chat,
ask them to rotate the key and store the replacement through `/secret set`.

## FastBill API Key Location

FastBill documents the API key as account access information available in the
FastBill account settings/profile area. Operators should retrieve it from the
FastBill UI, store the source pair as `FASTBILL_EMAIL` and `FASTBILL_API_KEY`,
then combine them locally into the derived `FASTBILL_BASIC_AUTH` route secret.

## Account Scoping

FastBill API credentials are scoped to the FastBill account user that owns the
API key. Use one HybridClaw secret route per FastBill account and name tenant-
specific routes explicitly, for example `FASTBILL_ACME_BASIC_AUTH` with
`--auth-secret-name FASTBILL_ACME_BASIC_AUTH`. Do not reuse one operator's API
key across unrelated customer workspaces.

Before a write, confirm the target account by reading a known customer or
invoice first. If the account cannot be verified from read data, stop before
passing `--operator-grant`.

## E-Invoicing Setup

FastBill supports XRechnung and ZUGFeRD when e-invoicing is enabled in the
account. Before creating mandate-bound B2B invoices, verify:

- seller master data: company/name, address, country, VAT ID, IBAN, BIC
- buyer master data: company/name, address, country, VAT ID
- XRechnung extras: customer email, phone, and buyer reference/Leitweg-ID
- direct debit extras: SEPA creditor ID, mandate reference, and buyer bank data

If these fields are incomplete, FastBill may create a normal PDF instead of a
valid e-invoice.

## Operator Grants

Read calls can run at default autonomy. Mutating calls need explicit operator
grant in the current task:

- customer and contact create/update/delete
- invoice create/update/delete/complete/cancel/lock/send/setpaid
- reminder emails through `invoice.sendbyemail`
- article, project, time, recurring, revenue, expense, document, and webhook creation or updates

Use `--dry-run` first when line items come from time tracking, email, or CSV
inputs.

## Source Notes

- FastBill API fundamentals and classic endpoint:
  https://apidocs.fastbill.com/fastbill/en/fundamentals.html
- FastBill invoice service fields:
  https://apidocs.fastbill.com/fastbill/en/invoice.html
- FastBill customer service fields:
  https://apidocs.fastbill.com/fastbill/en/customer.html
- FastBill e-invoice setup:
  https://support.fastbill.com/hc/de/articles/22209126147484-Einrichtung-der-E-Rechnung-in-FastBill
