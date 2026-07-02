---
name: posthog
description: "Capture PostHog events, update person properties, read persons, inspect feature flags, test flag evaluation, and run bounded analytics queries through gateway-managed secrets."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: posthog-project-token
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: POSTHOG_PROJECT_TOKEN
    scope: "PostHog public capture and flags endpoints on the configured ingestion host"
    how_to_obtain: "Open PostHog project settings and copy the project token. Set `POSTHOG_PROJECT_TOKEN` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set POSTHOG_PROJECT_TOKEN <token>` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set POSTHOG_PROJECT_TOKEN <token>`."
  - id: posthog-personal-api-key
    kind: bearer
    required: true
    secret_ref:
      source: store
      id: POSTHOG_PERSONAL_API_KEY
    scope: "PostHog private API for persons, feature flags, and query endpoints"
    how_to_obtain: "Create a PostHog personal API key with only the needed scopes. Set `POSTHOG_PERSONAL_API_KEY` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set POSTHOG_PERSONAL_API_KEY <key>` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set POSTHOG_PERSONAL_API_KEY <key>`."
config_variables:
  - id: posthog-host
    env: POSTHOG_HOST
    required: true
    scope: "PostHog app API host, for example https://us.posthog.com, https://eu.posthog.com, or a self-hosted base URL"
    how_to_obtain: "Use the base URL from your PostHog app and store it with `/env set POSTHOG_HOST \"https://us.posthog.com\"` or `hybridclaw env set POSTHOG_HOST \"https://us.posthog.com\"`."
  - id: posthog-ingest-host
    env: POSTHOG_INGEST_HOST
    required: true
    scope: "PostHog ingestion API host, for example https://us.i.posthog.com, https://eu.i.posthog.com, or a self-hosted base URL"
    how_to_obtain: "Use the ingestion host for your PostHog region and store it with `/env set POSTHOG_INGEST_HOST \"https://us.i.posthog.com\"` or `hybridclaw env set POSTHOG_INGEST_HOST \"https://us.i.posthog.com\"`."
  - id: posthog-project-id
    env: POSTHOG_PROJECT_ID
    required: true
    scope: "Numeric PostHog project id for private project APIs"
    how_to_obtain: "Find the numeric project id in PostHog project settings or API URLs, then store it with `/env set POSTHOG_PROJECT_ID \"12345\"` or `hybridclaw env set POSTHOG_PROJECT_ID \"12345\"`."
  - id: posthog-environment-id
    env: POSTHOG_ENVIRONMENT_ID
    required: false
    scope: "PostHog environment id for persons APIs when it differs from the project id"
    how_to_obtain: "Use the environment id shown in PostHog environment API URLs, then store it with `/env set POSTHOG_ENVIRONMENT_ID \"12345\"` or `hybridclaw env set POSTHOG_ENVIRONMENT_ID \"12345\"`. If omitted, pass `--environment-id` explicitly for persons calls."
metadata:
  hybridclaw:
    category: business
    short_description: "PostHog analytics, persons, and feature flag reads with guarded event writes."
    tags:
      - posthog
      - analytics
      - product-analytics
      - feature-flags
      - persons
      - hogql
    related_roadmap:
      - R21
      - R21.82
    issue: 1168
    stakes_tiers:
      green:
        - person-read
        - feature-flag-read
        - feature-flag-evaluation-test
        - insight-query
      amber:
        - event-capture
        - person-property-update
      red:
        - feature-flag-create-update-delete
        - person-delete
        - bulk-event-import
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: posthog
---

# PostHog

Use this skill for PostHog product analytics work: event capture, person
property reads and updates, feature flag inspection, feature flag test
evaluation, and bounded insight/HogQL queries.

## Scope

- capture a single product analytics event through the public capture endpoint
- update person properties with a guarded `$identify` capture event
- list and retrieve persons through the private persons API
- list and retrieve feature flag metadata
- test how a feature flag evaluates for a distinct id without changing the flag
- run private query API requests for HogQL, trends, funnels, retention, and
  other PostHog query payloads
- classify common PostHog auth, permission, validation, and rate-limit errors
- measure skill run cost through normal HybridClaw `UsageTotals`

## Out Of Scope

- creating, editing, rolling out, or deleting feature flags
- deleting persons or bulk deleting data
- bulk historical imports or migration-sized batch capture
- exporting large event/person tables on a schedule
- bypassing PostHog region, project, environment, or credential configuration

## Credential Rules

PostHog has two credential rails:

- `POSTHOG_PROJECT_TOKEN` is the public project token used in capture payloads.
- `POSTHOG_PERSONAL_API_KEY` is a private bearer credential used for persons,
  feature flags, and query endpoints.

Never paste either token into chat or helper arguments. The helper emits
`<secret:POSTHOG_PROJECT_TOKEN>` inside capture JSON and
`bearerSecretName: "POSTHOG_PERSONAL_API_KEY"` for private APIs, so the gateway
injects credentials server-side.

Recommended setup order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets` and set
   `POSTHOG_PROJECT_TOKEN` and `POSTHOG_PERSONAL_API_KEY`.
2. Browser `/chat` or TUI fallback:

```bash
/secret set POSTHOG_PROJECT_TOKEN <project-token>
/secret set POSTHOG_PERSONAL_API_KEY <personal-api-key>
/env set POSTHOG_HOST "https://us.posthog.com"
/env set POSTHOG_INGEST_HOST "https://us.i.posthog.com"
/env set POSTHOG_PROJECT_ID "12345"
/env set POSTHOG_ENVIRONMENT_ID "12345"
```

3. Local console fallback:

```bash
hybridclaw secret set POSTHOG_PROJECT_TOKEN "<project-token>"
hybridclaw secret set POSTHOG_PERSONAL_API_KEY "<personal-api-key>"
hybridclaw env set POSTHOG_HOST "https://us.posthog.com"
hybridclaw env set POSTHOG_INGEST_HOST "https://us.i.posthog.com"
hybridclaw env set POSTHOG_PROJECT_ID "12345"
hybridclaw env set POSTHOG_ENVIRONMENT_ID "12345"
```

Use the right regional hosts. For PostHog US Cloud, private API calls use
`https://us.posthog.com` and capture calls use `https://us.i.posthog.com`. For
EU Cloud, use `https://eu.posthog.com` and `https://eu.i.posthog.com`. For
self-hosted deployments, use the self-hosted base URL for both when that is how
the instance is exposed.

## Default Workflow

1. Use `plan` for natural-language requests when you need to classify read vs
   write risk before executing.
2. Run the bundled helper for live PostHog calls so request construction,
   gateway submission, credentials, and error interpretation stay in one place:
   ```bash
   node skills/posthog/posthog.cjs --format json run ...
   ```
3. Use `http-request` only when you need to inspect the generated request or
   when a runtime exposes the built-in `http_request` tool but cannot run the
   helper against the gateway directly:
   ```bash
   node skills/posthog/posthog.cjs --format json http-request ...
   ```
4. Pass only the emitted `httpRequest` object to the built-in `http_request`
   tool in that fallback path. Do not handcraft PostHog API calls from memory.
5. For amber operations, run `approval-plan` first, get explicit operator
   confirmation, then rerun the exact helper command with `--operator-grant`.
6. Keep capture payloads small and business-relevant. Do not send passwords,
   access tokens, full message bodies, contracts, or raw support transcripts as
   event/person properties.
7. If a live PostHog call returns 401 or 403, stop after that first failure and
   ask the operator to verify the matching stored credential and scopes.
8. If a private response is paginated and includes `next`, call the next URL
   only when the user needs another page.

## Command Contract

Inspect the helper surface:

```bash
node skills/posthog/posthog.cjs --help
```

Plan a request without contacting PostHog:

```bash
node skills/posthog/posthog.cjs --format json plan "Show active flags for checkout"
node skills/posthog/posthog.cjs --format json plan "Capture a trial_started event for user_123"
```

Build an approval plan for a capture write:

```bash
node skills/posthog/posthog.cjs --format json approval-plan capture-event \
  --event trial_started \
  --distinct-id user_123 \
  --properties-json '{"plan":"pro"}'
```

Capture a single event after explicit approval:

```bash
node skills/posthog/posthog.cjs --format json run capture-event \
  --event trial_started \
  --distinct-id user_123 \
  --properties-json '{"plan":"pro"}' \
  --operator-grant

node skills/posthog/posthog.cjs --format json http-request capture-event \
  --event trial_started \
  --distinct-id user_123 \
  --properties-json '{"plan":"pro"}' \
  --operator-grant
```

Update person properties after explicit approval:

```bash
node skills/posthog/posthog.cjs --format json http-request identify-person \
  --distinct-id user_123 \
  --set-json '{"company":"Acme GmbH","plan":"pro"}' \
  --operator-grant
```

Read persons:

```bash
node skills/posthog/posthog.cjs --format json run list-persons \
  --environment-id 12345 \
  --search acme \
  --limit 50

node skills/posthog/posthog.cjs --format json http-request get-person \
  --environment-id 12345 \
  --person-id 018f6c8f-...
```

Read feature flags and test evaluation:

```bash
node skills/posthog/posthog.cjs --format json http-request list-feature-flags

node skills/posthog/posthog.cjs --format json http-request get-feature-flag \
  --flag-id 42

node skills/posthog/posthog.cjs --format json http-request test-feature-flag \
  --flag-id 42 \
  --distinct-id user_123
```

Run an analytics query:

```bash
node skills/posthog/posthog.cjs --format json http-request query \
  --hogql "select event, count() from events where timestamp > now() - interval 7 day group by event order by count() desc limit 10"
```

Use `--query-json` for PostHog query payloads beyond HogQL:

```bash
node skills/posthog/posthog.cjs --format json http-request query \
  --query-json '{"kind":"TrendsQuery","series":[{"kind":"EventsNode","event":"$pageview"}]}'
```

Interpret a saved `http_request` error:

```bash
node skills/posthog/posthog.cjs --format json explain-error --payload-file /tmp/posthog-error.json
```
