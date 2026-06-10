---
name: mailchimp
description: "Operate Mailchimp Marketing audiences, campaigns, reports, automations, journeys, and Mailchimp Transactional/Mandrill email through SecretRef-backed helper requests."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: mailchimp-marketing-basic-auth
    kind: header
    required: true
    secret_ref:
      source: store
      id: MAILCHIMP_MARKETING_BASIC_AUTH
    scope: "Mailchimp Marketing API Authorization Basic header secret for https://<dc>.api.mailchimp.com/3.0"
    how_to_obtain: |
      Create a Mailchimp Marketing API key with the narrowest useful role for
      the account. Locally base64-encode `anystring:<api-key>` and store only
      that encoded credential in chat with
      `/secret set MAILCHIMP_MARKETING_BASIC_AUTH "<base64-user-colon-api-key>"`.
      From a local terminal, use
      `hybridclaw secret set MAILCHIMP_MARKETING_BASIC_AUTH "<base64-user-colon-api-key>"`.
      Set `MAILCHIMP_SERVER_PREFIX` to the data-center suffix after the last
      hyphen, for example `us21` from a key ending in `-us21`.
  - id: mailchimp-marketing-oauth-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: MAILCHIMP_MARKETING_OAUTH_TOKEN
    scope: "Mailchimp Marketing OAuth bearer token for https://login.mailchimp.com/oauth2/metadata and https://<dc>.api.mailchimp.com/3.0"
    how_to_obtain: |
      Complete Mailchimp's OAuth authorization flow outside this helper and
      store the resulting access token in chat with
      `/secret set MAILCHIMP_MARKETING_OAUTH_TOKEN "<oauth-token>"`.
      From a local terminal, use
      `hybridclaw secret set MAILCHIMP_MARKETING_OAUTH_TOKEN "<oauth-token>"`.
      Use helper commands with `--auth oauth`.
  - id: mandrill-api-key
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: MANDRILL_API_KEY
    scope: "Mailchimp Transactional / Mandrill API key for https://mandrillapp.com/api/1.0"
    how_to_obtain: |
      In a Mailchimp account with Transactional Email provisioned, create a
      Transactional API key and store it in chat with
      `/secret set MANDRILL_API_KEY "<mandrill-key>"`.
      From a local terminal, use
      `hybridclaw secret set MANDRILL_API_KEY "<mandrill-key>"`.
config_variables:
  - id: mailchimp-server-prefix
    env: MAILCHIMP_SERVER_PREFIX
    required: true
    scope: "Mailchimp Marketing API data-center prefix used in https://<dc>.api.mailchimp.com/3.0"
    how_to_obtain: |
      Use the suffix after the last hyphen in a Mailchimp Marketing API key,
      such as `us21`, or the data-center prefix returned by the OAuth metadata
      flow. Store it in chat with `/env set MAILCHIMP_SERVER_PREFIX us21`.
      From a local terminal, use
      `hybridclaw env set MAILCHIMP_SERVER_PREFIX us21`.
metadata:
  hybridclaw:
    category: marketing
    short_description: "Mailchimp audiences, campaigns, reports, journeys, and Mandrill transactional email."
    tags:
      - mailchimp
      - mandrill
      - email
      - marketing
      - campaigns
    related_roadmap:
      - R21.67
    issue: 1136
    stakes_tiers:
      green:
        - oauth.metadata
        - marketing.root
        - audience.list
        - audience.members
        - audience.member
        - audience.merge-fields
        - campaign.list
        - campaign.content-get
        - campaign.report
        - automation.list
        - automation.get
        - journey.list
        - journey.get
        - mandrill.message-info
      amber:
        - audience.member-upsert
        - audience.member-update
        - audience.member-archive
        - audience.tags-update
        - audience.merge-field-create
        - audience.merge-field-update
        - campaign.create
        - campaign.update
        - campaign.content-set
      red:
        - audience.bulk-plan
        - campaign.schedule
        - campaign.send
        - mandrill.send
        - mandrill.send-template
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: mailchimp
---

# Mailchimp

Use this skill for Mailchimp Marketing and Mailchimp Transactional work:
audience/list inspection, subscriber lookup and controlled mutations, tags,
merge fields, campaign draft operations, campaign content, scheduling/sending,
campaign reports, automation and journey readouts, and Mandrill transactional
message lookup or sends.

## Default Workflow

1. Start with `credential-check` when setup is uncertain. The helper emits
   gateway-resolved `<env:...>` and `<secret:...>` placeholders; it does not
   read runtime env or secret values itself. Missing `MAILCHIMP_SERVER_PREFIX`,
   `MAILCHIMP_MARKETING_BASIC_AUTH`, `MAILCHIMP_MARKETING_OAUTH_TOKEN`, or
   `MANDRILL_API_KEY` is surfaced by the gateway placeholder resolver or by a
   401/403 upstream response.
   Do not run `hybridclaw secret list`, `hybridclaw env list`, `grep`, or local
   file inspection from the agent sandbox to decide whether Mailchimp values
   are configured; those checks can see the wrong runtime surface.
   For stored OAuth access tokens, use `oauth.metadata --auth oauth` to retrieve the
   account-specific API endpoint and set `MAILCHIMP_SERVER_PREFIX` from the
   returned API endpoint host.
2. Use `mailchimp.cjs` to build allowlisted `http_request` payloads. Pass the
   emitted `httpRequest` object unchanged to the built-in `http_request` tool
   when a live Mailchimp call is required.
3. Treat `MAILCHIMP_MARKETING_BASIC_AUTH`, `MAILCHIMP_MARKETING_OAUTH_TOKEN`,
   and `MANDRILL_API_KEY` as SecretRefs only. Never ask the operator to paste
   tokens into chat, never print raw `Authorization` headers, and never include
   Mandrill keys in `--body-json`.
4. For audience writes, bulk subscriber plans, campaign draft/content writes,
   campaign schedule/send, and Mandrill sends, first run `approval-plan`, show
   the preview, and stop. After explicit operator approval for the named
   audience, campaign, or message target, run the approved helper command
   unchanged.
5. For 401 or 403, stop after the first failure and ask the operator to verify
   the token, user role, Transactional provisioning, and data-center prefix. Do
   not retry with broader permissions.
6. For 429, report rate-limit guidance from `Retry-After` or Mailchimp
   rate-limit headers when present. Do not start retry loops.
7. Minimize subscriber PII in summaries. Prefer subscriber hashes for lookup and
   archive/tag operations. Include email addresses only when required to create
   or update a member.

## Command Contract

```bash
node skills/mailchimp/mailchimp.cjs --help
node skills/mailchimp/mailchimp.cjs --format json credential-check
node skills/mailchimp/mailchimp.cjs --format json http-request oauth.metadata
node skills/mailchimp/mailchimp.cjs --format json http-request oauth.metadata --auth oauth
```

Build Marketing read requests:

```bash
node skills/mailchimp/mailchimp.cjs --format json http-request marketing.root
node skills/mailchimp/mailchimp.cjs --format json http-request audience.list --count 25
node skills/mailchimp/mailchimp.cjs --format json http-request audience.members --list-id <list-id> --status subscribed
node skills/mailchimp/mailchimp.cjs --format json http-request audience.member --list-id <list-id> --email user@example.com
node skills/mailchimp/mailchimp.cjs --format json http-request audience.merge-fields --list-id <list-id>
```

Build guarded audience mutation requests only after approval:

```bash
node skills/mailchimp/mailchimp.cjs --format json approval-plan audience.member-upsert \
  --list-id <list-id> --email user@example.com --status-if-new pending \
  --merge-fields-json '{"FNAME":"Ada"}' --tag customer:active

node skills/mailchimp/mailchimp.cjs --format json approval-plan audience.tags-update \
  --list-id <list-id> --email user@example.com --tag vip:active --tag stale:inactive

node skills/mailchimp/mailchimp.cjs --format json approval-plan audience.member-archive \
  --list-id <list-id> --email user@example.com

node skills/mailchimp/mailchimp.cjs --format json approval-plan audience.bulk-plan \
  --list-id <list-id> --operation member-upsert --count 2500 \
  --source-label imports/2026-06-newsletter.csv \
  --sample-json '{"email":"user@example.com","status_if_new":"pending","FNAME":"Ada"}'
```

Build campaign requests:

```bash
node skills/mailchimp/mailchimp.cjs --format json http-request campaign.list --status save
node skills/mailchimp/mailchimp.cjs --format json approval-plan campaign.create --body-json '{"type":"regular","recipients":{"list_id":"<list-id>"},"settings":{"subject_line":"Subject","title":"Draft","from_name":"Team","reply_to":"team@example.com"}}'
node skills/mailchimp/mailchimp.cjs --format json approval-plan campaign.content-set --campaign-id <campaign-id> --body-json '{"html":"<p>Hello</p>"}'
node skills/mailchimp/mailchimp.cjs --format json approval-plan campaign.schedule --campaign-id <campaign-id> --schedule-time 2026-06-01T09:00:00+00:00
node skills/mailchimp/mailchimp.cjs --format json approval-plan campaign.send --campaign-id <campaign-id>
```

Build report and read-only automation/journey requests:

```bash
node skills/mailchimp/mailchimp.cjs --format json http-request campaign.report --campaign-id <campaign-id> --kind overview
node skills/mailchimp/mailchimp.cjs --format json http-request campaign.report --campaign-id <campaign-id> --kind bounces
node skills/mailchimp/mailchimp.cjs --format json http-request campaign.report --campaign-id <campaign-id> --kind opens
node skills/mailchimp/mailchimp.cjs --format json http-request campaign.report --campaign-id <campaign-id> --kind clicks
node skills/mailchimp/mailchimp.cjs --format json http-request campaign.report --campaign-id <campaign-id> --kind email-activity
node skills/mailchimp/mailchimp.cjs --format json http-request automation.list
node skills/mailchimp/mailchimp.cjs --format json http-request journey.list
```

Build Mandrill transactional requests:

```bash
node skills/mailchimp/mailchimp.cjs --format json http-request mandrill.message-info --id <message-id>
node skills/mailchimp/mailchimp.cjs --format json approval-plan mandrill.send --body-json '{"message":{"from_email":"ops@example.com","to":[{"email":"user@example.com","type":"to"}],"subject":"Receipt","text":"Thanks"}}'
node skills/mailchimp/mailchimp.cjs --format json approval-plan mandrill.send-template --body-json '{"template_name":"receipt","template_content":[],"message":{"to":[{"email":"user@example.com","type":"to"}],"merge":true}}'
```

Classify a saved or live error:

```bash
node skills/mailchimp/mailchimp.cjs --format json classify-response --status 401 --body-json '{"title":"API Key Invalid"}'
node skills/mailchimp/mailchimp.cjs --format json classify-response --gateway-error 'Stored secret MAILCHIMP_MARKETING_BASIC_AUTH is not set.'
```

## Approval And Safety Boundaries

Green operations are read-only inventory, lookup, report, automation, journey,
and message-status calls. Amber operations mutate external Mailchimp state but
do not send mail by themselves. Red operations can send or schedule external
email and require explicit operator approval for the named campaign or message
target.

Bulk member mutation is intentionally exposed as a preview/approval boundary,
not as a direct batch execution command. For more than one subscriber, run
`approval-plan audience.bulk-plan` with the target list, operation, source
label, count, and a redacted sample row. After approval, generate exact
per-member helper commands and run them with `--operator-grant`. Do not call
Mailchimp batch endpoints from this skill.

Unsupported destructive operations include permanent member deletion, campaign
delete, audience delete, and Mandrill scheduled-message cancel/reschedule. The
helper exposes archive and tag changes, not irreversible data deletion.

## Credential Notes

Mailchimp Marketing uses `https://<dc>.api.mailchimp.com/3.0`, where `<dc>` is
the data-center subdomain for the account. API keys usually include this as the
suffix after the last hyphen. The helper defaults to `--auth api-key`, which
uses `Authorization: Basic <secret:MAILCHIMP_MARKETING_BASIC_AUTH>` and
`https://<env:MAILCHIMP_SERVER_PREFIX>.api.mailchimp.com/3.0/...` so the
gateway resolves both values server-side. Store the secret value as the base64
encoding of `anystring:<api-key>`, not the raw API key in prompt text.

OAuth access tokens are supported with `--auth oauth` and
`Authorization: OAuth <secret:MAILCHIMP_MARKETING_OAUTH_TOKEN>`. This skill
uses an already stored OAuth access token; it does not perform the browser OAuth
authorization flow itself. Use `oauth.metadata --auth oauth` to read the OAuth
token metadata endpoint and derive the account-specific data-center prefix
before calling Marketing API endpoints.

Mandrill requests place `key: "<secret:MANDRILL_API_KEY>"` in the JSON body so
the gateway performs placeholder replacement server-side. Do not include a
`key` field in `--body-json`; the helper rejects it.

## Result Handling

Base answers on successful live API results only. For setup failures, report
which layer failed: missing `MAILCHIMP_SERVER_PREFIX`, gateway missing runtime
secret, gateway policy denial, outbound network failure, Mailchimp 401/403,
Mailchimp 429, or upstream validation error. Do not infer stale gateway state
or network isolation without checking `hybridclaw gateway status`, logs, and
the returned helper/gateway error body.
