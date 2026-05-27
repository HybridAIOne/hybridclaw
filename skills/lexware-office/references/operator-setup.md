# Lexware Office Operator Setup

## API Key

Lexware Office uses a bearer API key for the Public API. Create the key in the
Lexware Office account under the Public API add-on page:

```text
https://app.lexware.de/addons/public-api
```

Store the value in the encrypted HybridClaw runtime secret store:

```bash
hybridclaw secret set LEXWARE_OFFICE_API_KEY "<api-key>"
```

Do not paste the API key into chat, shell logs, tickets, or saved helper JSON.
The skill helper emits `bearerSecretName: "LEXWARE_OFFICE_API_KEY"` so the
gateway injects `Authorization: Bearer ...` server-side.

## Public API Access

Lexware Office requires a plan with Public API access. If the gateway injects
the key but Lexware returns `401` or `403`, check that:

- the key belongs to the active organization
- Public API access is enabled for that account
- the key has not been deleted or regenerated
- the request targets `https://api.lexware.io`

## Secret Route

The helper can be used directly with the built-in `http_request` tool because
it sets `bearerSecretName`. If the operator prefers a URL route, configure:

```bash
hybridclaw secret route add https://api.lexware.io/ LEXWARE_OFFICE_API_KEY Authorization Bearer
```

The helper path remains the same either way:

```bash
node skills/lexware-office/lexware_office.cjs http-request profile
```

## Operational Notes

- Lexware documents a production resource URL of `https://api.lexware.io`.
- Productive integrations should use that URL rather than the older
  `api.lexoffice.io` gateway.
- Lexware rate limits the Public API to 2 requests per second across resource
  endpoints. Use small pages and back off on `429`.
- Contacts, articles, vouchers, and voucherlist are paginated. Use `--page` and
  `--size`; the helper caps `--size` at 250.
- Voucher updates require the current `version` property for optimistic locking.
  Read the voucher first, then update with the returned version.
- The public payments endpoint is read-only. It can show payment items and
  whether a financial transaction contributed to a payment. The skill can match
  an incoming bank transaction against open invoices locally and, after
  operator approval, write an auditable reconciliation note to the voucher.
  Lexware's public docs do not expose a direct banking-module assignment
  mutation.

## Minimum Read Checks

```bash
node skills/lexware-office/lexware_office.cjs http-request profile
node skills/lexware-office/lexware_office.cjs http-request list-contacts --size 5
node skills/lexware-office/lexware_office.cjs http-request list-invoices --status open --size 5
node skills/lexware-office/lexware_office.cjs http-request posting-categories
```

Pass each emitted `httpRequest` object to HybridClaw's `http_request` tool.
