---
name: ga4
description: "Run production Google Analytics 4 Data API reports with gateway-injected bearer auth, safe request review, traffic source, landing-page, time-series, revenue, session, and key-event reporting."
user-invocable: true
requires:
  bins:
    - python3
metadata:
  hybridclaw:
    category: marketing
    short_description: "GA4 reporting and analyst query planning."
    tags:
      - ga4
      - google-analytics
      - analytics
      - reporting
      - marketing
    stakes_tiers:
      green:
        - run-report
        - metadata-read
        - traffic-source-breakdown
        - landing-page-breakdown
        - time-series
      amber:
        - large-row-export
        - cross-tenant-report
      red:
        - admin-mutation
        - property-access-change
    escalation:
      writes: unsupported
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_contract: R5.4
      sub_limit_key: ga4
---

# GA4

Use this skill for Google Analytics 4 reporting through the Google Analytics
Data API: sessions, key events, revenue, traffic-source breakdowns,
landing-page breakdowns, time-series queries, ad-hoc analyst reads, dashboards,
scheduled reporting, ETL, and monitoring.

## Scope

- run GA4 `runReport` requests for a configured property
- translate common English analyst requests into reviewable Data API payloads
- review GA4 request JSON before execution
- build traffic-source, channel-group, landing-page, daily trend, revenue,
  session, user, and key-event reports
- support delegated-user OAuth and service-account auth through the same
  gateway bearer handle contract
- keep auth-mode selection in tenant/runtime config, not in prompt logic
- measure skill run cost through normal HybridClaw `UsageTotals`

## Default Workflow

1. Start with `report-plan` for natural-language requests unless the user
   already supplied a GA4 Data API request JSON.
2. Review generated or user-supplied request JSON with `review-request` before
   a live call.
3. For live GA4 API calls inside HybridClaw, use `http_request` directly when
   available. Pass the emitted `httpRequest` object from the helper to the tool.
4. Use the helper for offline planning/review and for gateway-proxied execution
   when `http_request` is unavailable:
   ```bash
   python3 skills/ga4/scripts/ga4.py ...
   ```
5. Treat all GA4 operations in this skill as read-only. Do not attempt Admin
   API mutations, property access changes, key-event changes, or tag changes.

## Auth Contract

The skill consumes a bearer secret handle and does not mint tokens itself.
Tenant config decides whether that handle resolves to delegated-user OAuth
or to a service-account access token.

Default delegated-user OAuth handle:

```bash
hybridclaw auth login google \
  --client-id "<google-oauth-client-id>" \
  --client-secret "<google-oauth-client-secret>" \
  --account you@example.com \
  --scopes "https://www.googleapis.com/auth/analytics.readonly"

hybridclaw auth status google
```

For delegated OAuth, use the default `bearerSecretName:
"GOOGLE_WORKSPACE_CLI_TOKEN"` or a `google-oauth` URL auth route.

For service-account automation, configure the tenant runtime so the selected
handle resolves to a short-lived service-account bearer token, then call the
helper with `--bearer-secret-name <handle>` or set:

```bash
hybridclaw secret set GA4_BEARER_SECRET_NAME "<tenant-service-account-handle>"
```

Do not paste OAuth access tokens, refresh tokens, service-account private keys,
or downloaded JSON key files into the prompt. Real credentials stay in the
HybridClaw secret runtime and are injected server-side by the gateway.

Optional stored defaults:

```bash
hybridclaw secret set GA4_PROPERTY_ID "<numeric-property-id>"
hybridclaw secret set GA4_BEARER_SECRET_NAME "GOOGLE_WORKSPACE_CLI_TOKEN"
```

## Command Contract

Plan a report from natural language:

```bash
python3 skills/ga4/scripts/ga4.py --format json report-plan \
  "Show me last week's organic conversions vs the prior week"
```

Build an `http_request` payload for a planned or hand-written request:

```bash
python3 skills/ga4/scripts/ga4.py --format json http-request 123456789 \
  --request-json '{"dateRanges":[{"startDate":"7daysAgo","endDate":"yesterday"}],"dimensions":[{"name":"date"}],"metrics":[{"name":"sessions"}],"limit":25}'
```

Run a report through the gateway helper path:

```bash
python3 skills/ga4/scripts/ga4.py --format json run-report 123456789 \
  --request-json '{"dateRanges":[{"startDate":"7daysAgo","endDate":"yesterday"}],"metrics":[{"name":"sessions"}]}'
```

Use service-account auth by choosing a different bearer handle:

```bash
python3 skills/ga4/scripts/ga4.py --format json http-request 123456789 \
  --bearer-secret-name GA4_SERVICE_ACCOUNT_ACCESS_TOKEN \
  --request-json '{"dateRanges":[{"startDate":"7daysAgo","endDate":"yesterday"}],"metrics":[{"name":"sessions"}]}'
```

Review request JSON offline:

```bash
python3 skills/ga4/scripts/ga4.py --format json review-request \
  '{"dateRanges":[{"startDate":"30daysAgo","endDate":"yesterday"}],"dimensions":[{"name":"landingPagePlusQueryString"}],"metrics":[{"name":"sessions"},{"name":"totalRevenue"}],"limit":25}'
```

Emit the analyst-query prompt-template payload:

```bash
python3 skills/ga4/scripts/ga4.py --format json prompt-template \
  "Daily sessions and revenue for the last 30 days"
```

Run the bundled eval suite:

```bash
python3 skills/ga4/scripts/ga4.py --format json eval-scenarios
```

## Working Rules

- Use numeric GA4 property ids. Accept `properties/<id>` input, but normalize it
  before API calls.
- Use `keyEvents` for conversion-style reporting unless the user explicitly
  requests a custom event metric.
- Use `sessionDefaultChannelGroup`, `sessionSourceMedium`,
  `landingPagePlusQueryString`, and `date` for the common production
  breakdowns before reaching for custom dimensions.
- Include a row limit. Default to 25 for ad-hoc reports and increase only when
  the user asks for an export or ETL-sized result.
- Ask for clarification when the request names a quarter without a year.
- Do not add Admin API writes to this skill. A separate admin skill would need
  explicit approval tiers and boundary tests.

## Eval Suite

The bundled scenarios cover 25 representative analyst requests across
sessions, key events, revenue, traffic source, landing page, time series,
comparisons, ecommerce, geographic, device, and safety/clarification cases.
