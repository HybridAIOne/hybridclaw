---
name: google-ads
description: "Manage Google Ads accounts with safe GAQL reporting, campaign planning, guarded mutations, and gateway-proxied REST API calls."
user-invocable: true
requires:
  bins:
    - python3
metadata:
  hybridclaw:
    category: marketing
    short_description: "Google Ads reporting and safe operations."
    tags:
      - google-ads
      - gaql
      - ppc
      - marketing
      - reporting
    stakes_tiers:
      green:
        - gaql-reporting
        - schema-introspection
        - recommendation-read
        - audience-count-read
      amber:
        - ad-group-edit
        - keyword-edit
        - audience-segment-create
        - recommendation-apply
        - recommendation-dismiss
      red:
        - budget-mutation
        - campaign-enable
        - campaign-pause
        - ad-copy-submit
        - bid-strategy-switch
        - customer-match-upload
        - conversion-action-edit
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_contract: R5.4
      sub_limit_key: google-ads
---

# Google Ads

Use this skill for Google Ads API work: GAQL reports, account and campaign
inspection, campaign/ad group/ad/keyword planning, recommendation review, and
carefully gated account mutations.

## Scope

- list accessible customers and MCC children
- run GAQL reporting queries through the official Google Ads REST API
- translate common English and German reporting requests into reviewable GAQL
- reuse the R21.6 NL-to-SQL review prompt payload shape for GAQL model review
- plan campaign, ad group, keyword, budget, bid strategy, recommendation, and
  audience operations with an explicit stakes tier
- execute approved campaign create/status/rename/remove/bid-strategy changes
- execute approved daily and lifetime budget updates
- execute approved ad group, keyword, and ad lifecycle changes
- execute approved Customer Match, remarketing, lookalike, and in-market/user
  interest audience operations
- execute approved conversion action create/status/attribution changes
- apply or dismiss approved Google Ads recommendations
- enforce brand-voice review before any ad-copy field is submitted
- refuse budget, campaign-state, bid strategy, ad-copy submission,
  conversion-action edit, and customer-match upload actions unless the user has
  already provided an explicit operator grant for that exact action
- measure skill run cost through normal HybridClaw `UsageTotals`

## Default Workflow

1. Start with reads. For reporting, draft or generate GAQL, review it, then run
   it only if the query is scoped enough for the request.
2. For live read-only Google Ads API calls, use `http_request` directly. Do not
   run the helper through `bash` for account listing, GAQL execution, or other
   read-only REST calls when `http_request` is available.
3. Use the bundled helper only for offline planning/review utilities and guarded
   mutation commands:
   ```bash
   python3 skills/google-ads/scripts/google_ads.py ...
   ```
4. Use `plan` before every write-like request. The plan output carries
   `stakesTier`, `requiresEscalation`, `requiredGrant`, and
   `brandVoiceGateRequired` fields.
5. Do not execute amber or red operations from the plan unless the user has
   granted the exact `requiredGrant` in the same turn or through an approved
   F14 escalation.
6. Run `/brand-voice` before submitting any generated headline, description,
   sitelink, callout, or other ad-copy asset. If brand voice is not configured,
   keep the copy as a draft and ask for approval before submission.
7. Use `http_request` for direct query execution and the helper `report-plan`
   when the user asks in natural language and a GAQL query must be generated.

## Secret Refs

Use `http_request` for live Google Ads HTTP calls. OAuth access tokens and the
developer token are injected server-side by the gateway from secret handles, so
real values never enter the model context. The helper uses the same gateway
contract only for commands that explicitly require helper-side validation.

Required setup:

```bash
hybridclaw auth login google \
  --client-id "<google-oauth-client-id>" \
  --client-secret "<google-oauth-client-secret>" \
  --account you@example.com \
  --scopes "https://www.googleapis.com/auth/adwords"

hybridclaw auth status google
```

Set `GOOGLEADS_DEVELOPER_TOKEN` in this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback:
   `/secret set GOOGLEADS_DEVELOPER_TOKEN "<developer-token>"`.
3. Local console fallback:
   `hybridclaw secret set GOOGLEADS_DEVELOPER_TOKEN "<developer-token>"`.

Do not ask the user to add `secret route` entries for normal Google Ads skill
use. The skill should pass `bearerSecretName: "GOOGLE_WORKSPACE_CLI_TOKEN"` and
`secretHeaders: [{ "name": "developer-token", "secretName":
"GOOGLEADS_DEVELOPER_TOKEN", "prefix": "" }]` in each `http_request` call.

Optional stored defaults use the same setup order: browser admin at
`/admin/secrets`, then `/secret set` in browser `/chat` or
TUI, then local console fallback.

```bash
hybridclaw secret set GOOGLEADS_CUSTOMER_ID "<customer-id-without-hyphens>"
hybridclaw secret set GOOGLEADS_LOGIN_CUSTOMER_ID "<manager-id-without-hyphens>"
```

If the account is managed through an MCC, include `--login-customer-id` on live
commands or store `GOOGLEADS_LOGIN_CUSTOMER_ID`. Customer ids must be sent to
the API without hyphens.

## Command Contract

List accessible Google Ads customers:

```json
{
  "url": "https://googleads.googleapis.com/v20/customers:listAccessibleCustomers",
  "method": "GET",
  "bearerSecretName": "GOOGLE_WORKSPACE_CLI_TOKEN",
  "secretHeaders": [
    {
      "name": "developer-token",
      "secretName": "GOOGLEADS_DEVELOPER_TOKEN",
      "prefix": ""
    }
  ],
  "skillName": "google-ads"
}
```

Run a GAQL report:

```json
{
  "url": "https://googleads.googleapis.com/v20/customers/1234567890/googleAds:searchStream",
  "method": "POST",
  "headers": {
    "login-customer-id": "1234567890"
  },
  "json": {
    "query": "SELECT campaign.id, campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 20"
  },
  "bearerSecretName": "GOOGLE_WORKSPACE_CLI_TOKEN",
  "secretHeaders": [
    {
      "name": "developer-token",
      "secretName": "GOOGLEADS_DEVELOPER_TOKEN",
      "prefix": ""
    }
  ],
  "skillName": "google-ads"
}
```

Plan GAQL from natural language without authentication:

```bash
python3 skills/google-ads/scripts/google_ads.py --format json report-plan \
  "Show German campaigns with CTR below 1% this week"
```

Emit the GAQL variant of the R21.6 NL-to-SQL prompt-template family:

```bash
python3 skills/google-ads/scripts/google_ads.py --format json prompt-template \
  "Show campaign clicks for last week" \
  --query "SELECT campaign.id, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 10"
```

Classify and inspect an operation before any write:

```bash
python3 skills/google-ads/scripts/google_ads.py --format json plan \
  "Bump the daily budget on campaign X by 20%"
```

Review ad copy before submission:

```bash
python3 skills/google-ads/scripts/google_ads.py --format json ad-copy-review \
  --headline "Fast CRM Migration" \
  --description "Switch cleanly with a migration plan"
```

Execute approved mutations only after the exact grant is present:

```bash
python3 skills/google-ads/scripts/google_ads.py campaign-status 1234567890 111222333 \
  --status PAUSED \
  --grant approve-google-ads-campaign-state-change

python3 skills/google-ads/scripts/google_ads.py campaign-create 1234567890 444555666 \
  --name "DE Search Brand" \
  --grant approve-google-ads-budget-or-bid-change

python3 skills/google-ads/scripts/google_ads.py campaign-bid-strategy 1234567890 111222333 \
  --strategy target-roas \
  --target-roas 4.0 \
  --grant approve-google-ads-budget-or-bid-change

python3 skills/google-ads/scripts/google_ads.py campaign-rename 1234567890 111222333 \
  --name "DE Search Brand - Exact" \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py campaign-remove 1234567890 111222333 \
  --grant approve-google-ads-campaign-state-change

python3 skills/google-ads/scripts/google_ads.py budget-amount 1234567890 444555666 \
  --amount-micros 25000000 \
  --grant approve-google-ads-budget-or-bid-change

python3 skills/google-ads/scripts/google_ads.py budget-lifetime-amount 1234567890 444555666 \
  --total-amount-micros 250000000 \
  --grant approve-google-ads-budget-or-bid-change

python3 skills/google-ads/scripts/google_ads.py ad-group-create 1234567890 111222333 \
  --name "DE Search Competitors" \
  --status PAUSED \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py ad-group-status 1234567890 777888999 \
  --status PAUSED \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py ad-group-rename 1234567890 777888999 \
  --name "DE Competitor Alternatives" \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py ad-group-remove 1234567890 777888999 \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py keyword-create 1234567890 777888999 \
  --text "crm migration" \
  --match-type EXACT \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py keyword-status 1234567890 777888999 111222333 \
  --status PAUSED \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py keyword-remove 1234567890 777888999 111222333 \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py rsa-create 1234567890 777888999 \
  --headline "Fast CRM Migration" \
  --headline "Clean Data Move" \
  --headline "Launch With Control" \
  --description "Switch cleanly with expert migration planning" \
  --description "Move your CRM data with a clear rollout plan" \
  --final-url "https://example.com" \
  --brand-voice-approved \
  --grant approve-google-ads-ad-copy-submit

python3 skills/google-ads/scripts/google_ads.py ad-status 1234567890 777888999 222333444 \
  --status PAUSED \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py ad-remove 1234567890 777888999 222333444 \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py conversion-action-create 1234567890 \
  --name "Lead form submit" \
  --category LEAD \
  --grant approve-google-ads-conversion-action-edit

python3 skills/google-ads/scripts/google_ads.py conversion-action-attribution 1234567890 222333444 \
  --attribution-model DATA_DRIVEN \
  --grant approve-google-ads-conversion-action-edit

python3 skills/google-ads/scripts/google_ads.py remarketing-list-create 1234567890 \
  --name "Pricing visitors" \
  --remarketing-action "customers/1234567890/remarketingActions/111222333" \
  --grant approve-google-ads-audience-management

python3 skills/google-ads/scripts/google_ads.py lookalike-list-create 1234567890 \
  --name "Buyer lookalikes" \
  --seed-user-list-id 111222333 \
  --country-code DE \
  --grant approve-google-ads-audience-management

python3 skills/google-ads/scripts/google_ads.py campaign-user-interest-target 1234567890 111222333 80400 \
  --grant approve-google-ads-audience-management

python3 skills/google-ads/scripts/google_ads.py customer-match-list-create 1234567890 \
  --name "Hashed CRM buyers" \
  --grant approve-google-ads-customer-match-upload

python3 skills/google-ads/scripts/google_ads.py customer-match-job-create 1234567890 \
  "customers/1234567890/userLists/111222333" \
  --grant approve-google-ads-customer-match-upload

python3 skills/google-ads/scripts/google_ads.py customer-match-add-hashes 1234567890 \
  "customers/1234567890/offlineUserDataJobs/111222333" \
  --sha256-email "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  --sha256-phone "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  --address-info-json '{"hashedFirstName":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","hashedLastName":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","countryCode":"DE","postalCode":"10115"}' \
  --grant approve-google-ads-customer-match-upload

python3 skills/google-ads/scripts/google_ads.py customer-match-job-run 1234567890 \
  "customers/1234567890/offlineUserDataJobs/111222333" \
  --grant approve-google-ads-customer-match-upload

python3 skills/google-ads/scripts/google_ads.py apply-recommendation 1234567890 \
  "customers/1234567890/recommendations/abc123" \
  --grant approve-google-ads-recommendation-apply

python3 skills/google-ads/scripts/google_ads.py dismiss-recommendation 1234567890 \
  "customers/1234567890/recommendations/abc123" \
  --grant approve-google-ads-recommendation-dismiss
```

Use `--validate-only` with mutation commands when you want Google Ads to
validate the request without executing it.

Run the offline eval suite:

```bash
python3 skills/google-ads/scripts/google_ads.py --format json eval-scenarios
```

## Working Rules

- Reads are autonomous by default when scoped to the requested account and date
  range.
- Every write starts as a plan. Treat the plan as authoritative for whether
  escalation is required.
- Any write to campaigns, budgets, ads, ad groups, keywords, bid strategies,
  conversion actions, recommendations, or audiences requires explicit operator
  approval before execution.
- Budget mutations, campaign pause/enable, ad-copy submission, customer-match
  uploads, bid-strategy switches, and conversion-action edits are red-tier.
  Refuse them without an exact approval grant.
- Customer-match uploads must use pre-hashed PII only. Do not hash raw customer
  PII inside the model context, and do not request raw customer lists in chat.
- Customer Match execution intentionally uses Google Ads API OfflineUserDataJobs
  for operators who need the Ads API path, while acknowledging that Google
  points new Customer Match implementations toward Data Manager in current
  guidance. Keep that as a deliberate product choice, not an accidental drift.
- Customer Match execution is split into explicit list creation, offline job
  creation, hash-only add operations, and job run commands. The helper accepts
  only 64-character SHA-256 hashes for email, phone, and address-info hash
  fields; raw customer identifiers remain out of scope.
- Recommendation applies are amber-tier even when Google presents them as a
  simple button. Read recommendations first, summarize the account impact, then
  ask for approval.
- Keep GAQL narrow: include a date window for performance metrics, use a
  `LIMIT` for exploratory reports, and select only fields needed for the task.
- For German-language requests, preserve the user's business terms in the
  narrative but emit GAQL using official English resource and field names.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` so evals can verify the
  accounting contract. R5.4 per-skill sub-limit enforcement remains a gateway
  concern; this skill declares the `google-ads` sub-limit key and emits the
  metering marker that enforcement consumes.

## Eval Suite

The fixture at `evals/scenarios.json` contains 36 offline scenarios across
GAQL reporting, campaign edits, ad authoring, audience management,
recommendation actions, conversion tracking, and high-stakes refusals. The
helper verifies each scenario's expected stakes tier, escalation requirement,
brand-voice gate, and cost-measurement contract.

## References

- Setup, OAuth, MCC headers, and GDPR notes:
  [references/setup-and-operations.md](references/setup-and-operations.md)

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/google-ads
python3 skills/google-ads/scripts/google_ads.py --help
python3 skills/google-ads/scripts/google_ads.py --format json eval-scenarios
```
