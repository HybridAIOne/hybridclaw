---
name: download-platform-invoices
description: Harvest monthly SaaS billing invoices into normalized records and official PDF files.
user-invocable: true
metadata:
  hybridclaw:
    category: business
    short_description: "Monthly SaaS invoice harvesting."
    tags:
      - billing
      - invoices
      - bookkeeping
      - datev
      - automation
    related_skills:
      - stripe
      - pdf
---
# Download Platform Invoices

Use this skill when the user wants monthly SaaS invoice PDFs collected from
billing portals or billing APIs for bookkeeping handoff.

## Output Contract

Each fetched invoice must produce one normalized JSON record and the original
official PDF. The record shape is:

```json
{
  "vendor": "openai",
  "invoice_no": "E-2026-03-001",
  "period": "2026-03",
  "issue_date": "2026-04-01",
  "due_date": "2026-04-15",
  "net": 123.45,
  "vat_rate": 0.19,
  "vat": 23.45,
  "gross": 146.9,
  "currency": "EUR",
  "pdf_path": "runs/2026-03/openai/E-2026-03-001.pdf",
  "source_url": "https://platform.openai.com/account/billing",
  "checksum_sha256": "64 lowercase hex characters"
}
```

Validate records with the colocated `schema.json` contract. Keep `pdf_path`
relative to the invoice run directory.

## Adapter Contract

Adapters follow this shape:

```ts
login(credentials) -> session
listInvoices(session, { since }) -> InvoiceMeta[]
download(session, invoice) -> Uint8Array
```

The runtime implementation is colocated with this skill:

- Stripe API adapter
- browser-driver scrape adapters for GitHub, OpenAI, Anthropic, Atlassian,
  and LinkedIn
- native API adapters for Google Ads InvoiceService, AWS Invoicing, Azure
  Billing invoices, and GCP Cloud Billing account authorization. Google does
  not expose invoice PDF listing/download in the public Cloud Billing REST API,
  so the GCP adapter uses the browser document driver for the Documents page
  after API authorization.
- DATEV Unternehmen Online handoff prefers an injected DATEV Datenservice,
  Rechnungsdatenservice/Belegbilderservice, MCP, or certified API client. If no
  such client is configured, it falls back to browser upload through DATEV
  Upload online/Belege online.
- manifest-based idempotency using `(vendor, invoice_no)` and
  `checksum_sha256`
- audit event emission per fetched invoice
- recorded fixture replay for every launch provider with sanitized HTTPS trace
  metadata and DOM snapshots, so CI does not touch live billing portals

## Credential Rules

- Store secrets in HybridClaw encrypted runtime secrets with provider-specific
  uppercase names such as `STRIPE_INVOICE_API_KEY`,
  `OPENAI_INVOICE_PASSWORD`, or `GITHUB_INVOICE_TOTP_SECRET`.
- Resolve credentials through `resolveInvoiceCredentials`; do not inline or log
  cleartext secrets.
- Keep provider credential references in invoice harvester config as
  `{ "source": "store", "id": "PROVIDER_SECRET_NAME" }`. Runtime config
  revisions track the references, while encrypted secret values stay out of
  revision content.
- When a provider fails with an auth/401/403 class error, the monthly runner
  asks the injected credential store to rotate the referenced secret once and
  rolls that revision back if the retry still fails.
- TOTP is supported when a provider driver uses a `totpSecret` credential.
- Push MFA and captchas must stop the provider run and emit
  `invoice.operator_escalation_required` for F8 operator routing.

## Google Ads InvoiceService

Use Google's documented InvoiceService flow for Google Ads invoices:

```text
GET https://googleads.googleapis.com/v24/customers/<customer-id>/invoices?billingSetup=customers/<customer-id>/billingSetups/<billing-setup-id>&issueYear=<yyyy>&issueMonth=<MONTH>
```

Then download the returned `pdfUrl` with the same OAuth identity. Do not write
one-off Node or shell scripts for live Google Ads calls unless the user
explicitly asks for diagnostics.

Required inputs:

- Google OAuth from `hybridclaw auth login google` with
  `https://www.googleapis.com/auth/adwords`.
- `GOOGLEADS_DEVELOPER_TOKEN`, routed to the `developer-token` header.
- Target serving `customerId`, without hyphens.
- `billingSetup` resource name:
  `customers/<customer-id>/billingSetups/<billing-setup-id>`.
- Optional `loginCustomerId`, without hyphens, if access goes through an
  MCC/manager account.

Set the routes once:

```bash
hybridclaw auth status google
hybridclaw secret route add https://googleads.googleapis.com/ google-oauth Authorization Bearer
hybridclaw secret route add https://googleads.googleapis.com/ GOOGLEADS_DEVELOPER_TOKEN developer-token none
```

If identifiers are missing, use only these Google Ads API calls:

- Accessible customers:
  `GET https://googleads.googleapis.com/v24/customers:listAccessibleCustomers`
- MCC children:
  `POST https://googleads.googleapis.com/v24/customers/<manager-customer-id>/googleAds:search`
  with `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager, customer_client.level, customer_client.status FROM customer_client WHERE customer_client.level <= 1`
- Billing setups:
  `POST https://googleads.googleapis.com/v24/customers/<customer-id>/googleAds:search`
  with `SELECT billing_setup.resource_name, billing_setup.payments_account, billing_setup.status FROM billing_setup`

Never call `POST /v24/customers/<customer-id>:search`; GoogleAdsService REST
search is `/customers/<customer-id>/googleAds:search`.

Built-in adapter helpers:

- `listAccessibleCustomers(credentials)`
- `discoverCustomerClients(credentials)`
- `discoverBillingSetups(credentials)`
- `listInvoices(session, { since })`
- `download(session, invoice)`

Google Ads error handling:

- Report the exact Google Ads response body, especially `status`, `reason`,
  `message`, `request-id`, and `consumer` project. Do not infer setup problems
  from fallback-token failures.
- `SERVICE_DISABLED` means the Google Cloud project that owns the OAuth client
  has not enabled `googleads.googleapis.com`.
- `USER_PERMISSION_DENIED` usually means the OAuth user lacks access to the
  target client account, or the request needs a `login-customer-id` header for
  the managing MCC account.
- `insufficient authentication scopes` means the stored Google OAuth grant must
  be refreshed with `https://www.googleapis.com/auth/adwords`.

## Run Discipline

- Process one provider at a time.
- Reuse a session-isolated browser profile per provider so cookies can persist
  between monthly runs.
- Add jitter between scrape providers when running live.
- Never solve captchas silently.
- Never OCR invoices in this skill; adapters return the official PDF.

## DATEV Handoff

When paired with the DATEV workflow, run invoice harvesting first, review the
manifest, then pass the normalized records and PDF paths to the DATEV upload
step. The composed workflow fixture is
`tests/fixtures/workflows/monthly-invoice-run.workflow.yaml`.

The runtime composition helper is `runMonthlyInvoiceRun` in `harvester.cjs`. It
runs configured providers one at a time, emits invoice audit events, and calls
`DatevUnternehmenOnlineUploadAdapter` when the handoff is enabled and the
operator provides a configured DATEV API/MCP client or upload driver/profile.
