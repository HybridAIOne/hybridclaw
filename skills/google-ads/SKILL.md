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
---

# Google Ads

Use this skill for Google Ads API work: GAQL reports, account and campaign
inspection, campaign/ad group/ad/keyword planning, recommendation review, and
carefully gated account mutations.

## Scope

- list accessible customers and MCC children
- run GAQL reporting queries through the official Google Ads REST API
- translate common English and German reporting requests into reviewable GAQL
- plan campaign, ad group, keyword, budget, bid strategy, recommendation, and
  audience operations with an explicit stakes tier
- enforce brand-voice review before any ad-copy field is submitted
- refuse budget, campaign-state, bid strategy, ad-copy submission,
  conversion-action edit, and customer-match upload actions unless the user has
  already provided an explicit operator grant for that exact action
- measure skill run cost through normal HybridClaw `UsageTotals`

## Default Workflow

1. Start with reads. For reporting, draft or generate GAQL, review it, then run
   it only if the query is scoped enough for the request.
2. Use the bundled helper from the current workspace:
   ```bash
   python3 skills/google-ads/scripts/google_ads.py ...
   ```
3. Use `plan` before every write-like request. The plan output carries
   `stakesTier`, `requiresEscalation`, `requiredGrant`, and
   `brandVoiceGateRequired` fields.
4. Do not execute amber or red operations from the plan unless the user has
   granted the exact `requiredGrant` in the same turn or through an approved
   F14 escalation.
5. Run `/brand-voice` before submitting any generated headline, description,
   sitelink, callout, or other ad-copy asset. If brand voice is not configured,
   keep the copy as a draft and ask for approval before submission.
6. Use `gaql` for direct query execution and `report-plan` when the user asks in
   natural language.

## Secret Refs

The helper routes live Google Ads HTTP calls through the HybridClaw gateway
proxy. OAuth access tokens and the developer token are injected server-side by
configured secret routes, so real values never enter the helper process or the
model context.

Required setup:

```bash
hybridclaw auth login google \
  --client-id "<google-oauth-client-id>" \
  --client-secret "<google-oauth-client-secret>" \
  --account you@example.com \
  --scopes "https://www.googleapis.com/auth/adwords"

hybridclaw auth status google
hybridclaw secret set GOOGLEADS_DEVELOPER_TOKEN "<developer-token>"
hybridclaw secret route add https://googleads.googleapis.com/ google-oauth Authorization Bearer
hybridclaw secret route add https://googleads.googleapis.com/ GOOGLEADS_DEVELOPER_TOKEN developer-token none
```

Optional stored defaults:

```bash
hybridclaw secret set GOOGLEADS_CUSTOMER_ID "<customer-id-without-hyphens>"
hybridclaw secret set GOOGLEADS_LOGIN_CUSTOMER_ID "<manager-id-without-hyphens>"
```

If the account is managed through an MCC, include `--login-customer-id` on live
commands or store `GOOGLEADS_LOGIN_CUSTOMER_ID`. Customer ids must be sent to
the API without hyphens.

## Command Contract

List accessible Google Ads customers:

```bash
python3 skills/google-ads/scripts/google_ads.py customers
```

Run a GAQL report:

```bash
python3 skills/google-ads/scripts/google_ads.py gaql 1234567890 \
  "SELECT campaign.id, campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 20"
```

Plan GAQL from natural language without authentication:

```bash
python3 skills/google-ads/scripts/google_ads.py --format json report-plan \
  "Show German campaigns with CTR below 1% this week"
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

python3 skills/google-ads/scripts/google_ads.py budget-amount 1234567890 444555666 \
  --amount-micros 25000000 \
  --grant approve-google-ads-budget-or-bid-change

python3 skills/google-ads/scripts/google_ads.py ad-group-create 1234567890 111222333 \
  --name "DE Search Competitors" \
  --status PAUSED \
  --grant approve-google-ads-structure-edit

python3 skills/google-ads/scripts/google_ads.py keyword-create 1234567890 777888999 \
  --text "crm migration" \
  --match-type EXACT \
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

python3 skills/google-ads/scripts/google_ads.py apply-recommendation 1234567890 \
  "customers/1234567890/recommendations/abc123" \
  --grant approve-google-ads-recommendation-apply
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
- New Customer Match workflows should use Google's Data Manager API instead of
  Google Ads API uploads. This skill stops at planning/refusal for Customer
  Match until a Data Manager implementation is added.
- Recommendation applies are amber-tier even when Google presents them as a
  simple button. Read recommendations first, summarize the account impact, then
  ask for approval.
- Keep GAQL narrow: include a date window for performance metrics, use a
  `LIMIT` for exploratory reports, and select only fields needed for the task.
- For German-language requests, preserve the user's business terms in the
  narrative but emit GAQL using official English resource and field names.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` so evals can verify the
  accounting contract.

## Eval Suite

The fixture at `evals/scenarios.json` contains 30 offline scenarios across
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
