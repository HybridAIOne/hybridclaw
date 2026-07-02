# Google Ads Setup And Operations

## Developer Token

Google Ads API calls require a Google Ads developer token in addition to OAuth.
Create or reuse a Google Ads manager account, open API Center, request a
developer token, and set it in HybridClaw in this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback:
   `/secret set GOOGLEADS_DEVELOPER_TOKEN "<developer-token>"`.
3. Local console fallback:

```bash
hybridclaw secret set GOOGLEADS_DEVELOPER_TOKEN "<developer-token>"
hybridclaw secret route add https://googleads.googleapis.com/ GOOGLEADS_DEVELOPER_TOKEN developer-token none
```

Basic access is normally suitable for test accounts. Production use generally
requires standard access review from Google. Do not place the token in
workspace files, shell history examples with a real value, or prompt text.

## OAuth

Use the existing HybridClaw Google OAuth rail with the Google Ads scope:

```bash
hybridclaw auth login google \
  --client-id "<google-oauth-client-id>" \
  --client-secret "<google-oauth-client-secret>" \
  --account you@example.com \
  --scopes "https://www.googleapis.com/auth/adwords"

hybridclaw secret route add https://googleads.googleapis.com/ google-oauth Authorization Bearer
```

This stores the refresh token in the encrypted runtime secret store. At request
time the gateway mints a short-lived access token and injects it only into
`*.googleapis.com` calls.

## MCC And Customer Ids

Google Ads API customer ids are sent without hyphens. If the OAuth user is a
manager account, send the MCC id as `login-customer-id` and the client account
id in the REST path:

```bash
python3 skills/google-ads/scripts/google_ads.py gaql 1234567890 \
  --login-customer-id 9876543210 \
  "SELECT campaign.id, campaign.name FROM campaign LIMIT 20"
```

Store defaults when useful in the same setup order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback with `/secret set GOOGLEADS_* ...`.
3. Local console fallback:

```bash
hybridclaw secret set GOOGLEADS_CUSTOMER_ID "1234567890"
hybridclaw secret set GOOGLEADS_LOGIN_CUSTOMER_ID "9876543210"
```

## GAQL Reporting Guardrails

Use GAQL for reporting reads. Keep queries small and auditable:

- include `segments.date DURING ...` or a bounded date predicate for metrics
- select only fields needed for the question
- add `LIMIT` for exploratory reports
- use customer/account filters when reporting across an MCC
- review generated GAQL before execution when the prompt is ambiguous

Common starting points:

```sql
SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros
FROM campaign
WHERE segments.date DURING LAST_7_DAYS
ORDER BY metrics.clicks DESC
LIMIT 25
```

```sql
SELECT ad_group.id, ad_group.name, campaign.name, metrics.clicks, metrics.ctr, metrics.conversions
FROM ad_group
WHERE segments.date DURING THIS_WEEK
ORDER BY metrics.ctr ASC
LIMIT 25
```

## Mutation Guardrails

Treat all account changes as spend-affecting until proven otherwise.

Green reads:

- GAQL reporting
- customer and campaign listing
- recommendation reads
- audience size reads
- field/schema inspection

Amber writes:

- ad group edits
- keyword additions, edits, or pauses
- audience segment creation without customer-match uploads
- recommendation applies under a tenant-approved ceiling
- recommendation dismissals under a tenant-approved ceiling

Red writes:

- campaign create, pause, enable, remove, or bid-strategy switch
- daily or lifetime budget mutation
- ad creative submission
- customer-match upload
- conversion action create or edit

For amber or red actions, use the helper `plan` command, show the
`requiredGrant`, and proceed only after explicit operator approval.

Executable helper commands use the official Google Ads REST mutate pattern:
`POST /customers/<customer-id>/<resource>:mutate` with an `operations` array.
The helper refuses to send those requests unless `--grant` exactly matches the
operation's required grant.

Supported executable operations:

- `campaign-create`, `campaign-status`, `campaign-rename`, and
  `campaign-remove` cover campaign lifecycle operations
- `campaign-bid-strategy` switches portfolio or standard bidding strategy
  fields under the budget/bid grant
- `budget-amount` updates campaign budget `amountMicros`
- `budget-lifetime-amount` updates campaign budget `totalAmountMicros`
- `ad-group-create` creates an ad group
- `ad-group-status`, `ad-group-rename`, and `ad-group-remove` cover ad group
  lifecycle operations
- `keyword-create` creates an ad group criterion keyword
- `keyword-status` updates keyword criterion `status`; Google Ads criterion resource names are composite, so pass both ad group id and criterion id
- `keyword-remove` removes an ad group criterion keyword
- `rsa-create` creates a responsive search ad after brand-voice approval
- `ad-status` and `ad-remove` cover ad group ad lifecycle operations
- `conversion-action-create`, `conversion-action-status`, and
  `conversion-action-attribution` cover conversion action lifecycle and
  attribution adjustments
- `remarketing-list-create`, `lookalike-list-create`, and
  `campaign-user-interest-target` cover non-PII audience management
- `customer-match-list-create`, `customer-match-job-create`,
  `customer-match-add-hashes`, and `customer-match-job-run` cover the guarded
  Customer Match flow with hash-only inputs
- `apply-recommendation` applies a recommendation through
  `recommendations:apply`
- `dismiss-recommendation` dismisses a recommendation through
  `recommendations:dismiss` with the separate
  `approve-google-ads-recommendation-dismiss` grant

Add `--validate-only` to mutation commands when you want Google Ads API
validation without execution.

## Brand Voice

Before submitting any field that becomes ad copy, run the `brand-voice` command
or otherwise inspect the configured brand-voice plugin state. This applies to:

- responsive search ad headlines
- descriptions
- sitelinks
- callouts
- display copy
- final user-facing recommendation text

When brand voice is not configured, keep output as a draft and ask for approval
before submission.

## Customer Match And GDPR

Customer Match can touch personal data even when Google requires hashes. The
skill must not ingest raw customer lists in chat. Execution is split into
explicitly approved steps: create a CRM-based user list, create an offline user
data job, add only pre-hashed SHA-256 identifiers, then run the job.

This is an intentional pivot from the earlier plan-only posture. Google's
current direction for new Customer Match implementations points toward Data
Manager, but this skill supports the Google Ads API OfflineUserDataJobs path for
operators who explicitly choose that route and grant the upload. The guardrail
is narrow: the helper rejects non-hash upload values, does not hash PII itself,
and never accepts raw email, phone, address, or name fields.

`customer-match-add-hashes` accepts:

- `--sha256-email` for hashed email identifiers
- `--sha256-phone` for hashed phone identifiers
- `--address-info-json` with hashed `hashedFirstName`, hashed
  `hashedLastName`, `countryCode`, and optional `postalCode` or
  `hashedStreetAddress`

For EU residents, confirm the processing basis and data-residency expectations
with the operator before preparing the upload. If those details are missing,
stop at a plan.
