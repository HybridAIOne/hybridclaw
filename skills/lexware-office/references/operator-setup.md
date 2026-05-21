# Lexware Office Operator Setup

## API Surface

Use the current Lexware Public API gateway:

```text
https://api.lexware.io/v1
```

Lexware rebranded from lexoffice to Lexware and changed the production API
gateway on 2025-05-26. Use `https://api.lexware.io` for new integrations.

## Secret Storage

Generate the private API key in Lexware Office:

```text
https://app.lexware.de/addons/public-api
```

Store it in HybridClaw encrypted runtime secrets:

```bash
hybridclaw secret set LEXWARE_OFFICE_API_KEY <lexware-office-api-key>
```

Do not paste the API key into chat, shell history, eval fixtures, logs, or skill
arguments. The helper emits `http_request` payloads with:

```json
{
  "bearerSecretName": "LEXWARE_OFFICE_API_KEY",
  "skillName": "lexware-office"
}
```

That lets the gateway inject `Authorization: Bearer ...` without exposing the
secret value to the model.

For tenant-specific accounts, store a separate secret and pass it as:

```bash
node skills/lexware-office/lexware_office.cjs http-request list-invoices \
  --bearer-secret-name LEXWARE_OFFICE_API_KEY_TENANT_A
```

## Operator Grants

Read operations can run at default autonomy:

- profile, contacts, articles/products, invoices, voucherlist, vouchers
- payment status through `/payments/{id}`
- posting categories
- derived income statement source requests from voucherlist metadata

Write operations require explicit operator grant in the current task:

- `create-invoice`
- `log-expense`
- `upload-file`
- `attach-voucher-file`
- `match-transaction`

Use `upload-file` for `POST /files` to place voucher files in the Lexware
unchecked folder. Use `attach-voucher-file` for `POST /vouchers/{id}/files` when
the operator already selected the target voucher.

`match-transaction` is a manual handoff because the Lexware Public API exposes
payment status and bank-linked payment items, but not raw bank transaction feeds
or a transaction matching write endpoint. The assistant must not invent an API
call for that action.

## API Notes

- Contacts and voucherlist search values containing `&`, `<`, or `>` need HTML
  entity encoding before URL encoding. The helper handles this for supported
  search keys.
- Lexware API rate limits are documented as 2 requests per second. Paginated
  reporting workflows should throttle requests.
- Voucher updates use optimistic locking with a `version` property. This skill
  does not perform voucher update writes; if a future write path is added, fetch
  the latest resource version first.
- Income statement output is derived from voucherlist revenue/expense metadata.
  Lexware Public API does not provide a dedicated income-statement or BWA
  endpoint.
- Bank-transaction reads are derived from `/payments/{voucherId}` responses by
  extracting `paymentItems` whose `paymentItemType` is
  `partPaymentFinancialTransaction`.

## Validation

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/lexware-office
node skills/lexware-office/lexware_office.cjs --help
node skills/lexware-office/lexware_office.cjs eval-scenarios
node skills/lexware-office/lexware_office.cjs http-request list-invoices
node skills/lexware-office/lexware_office.cjs income-statement-plan --from 2026-01-01 --to 2026-03-31
node skills/lexware-office/lexware_office.cjs aggregate-income-statement --revenue-json '{"content":[{"voucherType":"invoice","totalAmount":100}]}' --expenses-json '{"content":[{"voucherType":"purchaseinvoice","totalAmount":40}]}'
node skills/lexware-office/lexware_office.cjs bank-transactions-from-payments --payments-json '{"id":"voucher-1","paymentItems":[{"paymentItemType":"partPaymentFinancialTransaction","amount":100,"currency":"EUR"}]}'
```

## References

- Lexware Public API documentation: https://developers.lexware.io/docs/
- Invoice cookbook: https://developers.lexware.io/cookbooks/invoices/
- Bookkeeping cookbook: https://developers.lexware.io/cookbooks/bookkeeping/
- Public API key page: https://app.lexware.de/addons/public-api
- Lexware status page: https://status.lexware.de
