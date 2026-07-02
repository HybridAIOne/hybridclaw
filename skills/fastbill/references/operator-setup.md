# FastBill Operator Setup

## API Endpoint

The classic FastBill API uses this central service URL:

```text
https://my.fastbill.com/api/1.0/api.php
```

The HybridClaw secret route uses the parent prefix `https://my.fastbill.com/api/1.0/`
so header injection matches this exact endpoint. Use only the full `api.php`
URL as the request URL; the parent prefix redirects and can be blocked by the
SSRF redirect guard. Requests are POST requests with an XML body containing
`FBAPI`, `SERVICE`, `FILTER`, and/or `DATA` elements.

## Authentication

FastBill classic API authentication uses HTTP Basic auth with the account email
address as the username and the account API key as the password. API access is
stateless, so the credentials are submitted for every request.

Set the Basic credential as a HybridClaw runtime secret in this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback:
   `/secret set FASTBILL_BASIC_AUTH <base64-output>`.
3. Local console fallback:

```bash
hybridclaw secret set FASTBILL_EMAIL you@example.com
hybridclaw secret set FASTBILL_API_KEY <fastbill-api-key>
printf '%s:%s' "$FASTBILL_EMAIL" "$FASTBILL_API_KEY" | base64
hybridclaw secret set FASTBILL_BASIC_AUTH <base64-output>
hybridclaw secret route add https://my.fastbill.com/api/1.0/ FASTBILL_BASIC_AUTH Authorization Basic
```

The helper uses only the derived `FASTBILL_BASIC_AUTH` route because HTTP Basic
auth requires `base64(email:api-key)` as one header value. Keeping
`FASTBILL_EMAIL` and `FASTBILL_API_KEY` as stored secrets records the source
credential pair without exposing either value to the model.

Do not paste the API key into the model context. If a user provides it in chat,
ask them to rotate the key and store the replacement through browser admin at
`/admin/secrets`, falling back to `/secret set` in browser
`/chat` or TUI only if the admin page is unavailable.

## Gateway Proxy Authentication

Inside HybridClaw, live FastBill calls should use the built-in `http_request`
tool, not bash/curl. The tool already holds the local gateway bearer token in
memory and can ask the gateway to inject `FASTBILL_BASIC_AUTH` through
`secretHeaders`.

The helper's `http-request` command is a no-network serializer that returns the
exact `http_request` payload for the model to send. The helper's direct
`request` command is only for operator-controlled local shell tests where a
valid gateway token is already exported in the process environment:

```bash
export HYBRIDCLAW_GATEWAY_TOKEN=<gateway-or-web-api-token>
node skills/fastbill/fastbill.cjs request invoice.get --filter-json '{"INVOICE_ID":"123"}'
```

Do not store `HYBRIDCLAW_GATEWAY_TOKEN` with `hybridclaw secret set` as a fix
for model-runtime FastBill calls. Stored secrets are for outbound API
credentials, not for exposing the local gateway bearer token to bash helpers.

## FastBill 401 Diagnostics

A FastBill response containing `Wrong API KEY or user credentials` means the
request reached FastBill and the gateway route injected an Authorization header.
It does not mean the secret route is missing. Recreate `FASTBILL_BASIC_AUTH`
from the exact FastBill login email and current API key, and avoid copying extra
spaces or shell prompts into the base64 value.

Keep the route prefix unchanged:

```bash
hybridclaw secret route add https://my.fastbill.com/api/1.0/ FASTBILL_BASIC_AUTH Authorization Basic
```

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
