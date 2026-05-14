---
name: hubspot
description: "Read HubSpot contacts, companies, and deals; update deal stages and lifecycle stages; log notes and tasks through gateway-minted OAuth tokens."
user-invocable: true
requires:
  bins:
    - node
metadata:
  hybridclaw:
    category: business
    short_description: "HubSpot CRM reads and guarded writes."
    tags:
      - hubspot
      - crm
      - contacts
      - companies
      - deals
      - oauth
    stakes_tiers:
      green:
        - contact-read
        - company-read
        - deal-read
        - property-read
      amber:
        - deal-stage-update
        - lifecycle-stage-update
        - note-create
        - task-create
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: hubspot
---

# HubSpot

Use this skill for HubSpot CRM work when the operator has connected a HubSpot
OAuth app to HybridClaw.

## Scope

- read contacts, companies, and deals
- search high-frequency CRM objects by common properties
- inspect HubSpot CRM properties for contacts, companies, and deals
- update a deal's `dealstage`
- update contact, company, or deal `lifecyclestage`
- create timeline notes associated with contacts, companies, or deals
- create tasks associated with contacts, companies, or deals
- plan common natural-language CRM requests before building API calls
- build ordered natural-language workflows with lookup, property-validation, and
  write steps for the high-frequency CRM operations
- validate internal HubSpot stage option values from saved property metadata
- interpret common HubSpot authentication, authorization, stage, and rate-limit
  errors
- measure cost per assistant run through normal HybridClaw `UsageTotals`

## Credential Rules

HubSpot uses OAuth. Store the HubSpot client secret and refresh token in
HybridClaw encrypted runtime secrets; never paste tokens into a prompt.

Recommended setup:

```bash
hybridclaw auth login hubspot \
  --client-id "<hubspot-oauth-client-id>" \
  --client-secret "<hubspot-oauth-client-secret>" \
  --account sales@example.com
```

For non-browser setup with an existing refresh token:

```bash
hybridclaw auth login hubspot \
  --client-id "<hubspot-oauth-client-id>" \
  --client-secret "<hubspot-oauth-client-secret>" \
  --refresh-token "<refresh-token>"
```

The gateway stores `HUBSPOT_CLIENT_SECRET` and `HUBSPOT_REFRESH_TOKEN`, mints a
short-lived access token on demand, and injects it only when an `http_request`
uses `bearerSecretName: "HUBSPOT_ACCESS_TOKEN"` against HubSpot API hosts.

Required OAuth scopes depend on the task. The default login scope set covers:
contacts, companies, deals, notes, tasks, CRM schema reads, and `oauth`.

## Default Workflow

1. Start with reads or `plan`. Do not mutate CRM state unless the user clearly
   asks for the exact write.
2. Run the bundled helper to build an `http_request` wrapper:
   ```bash
   node skills/hubspot/hubspot.cjs ...
   ```
3. Pass only the emitted `httpRequest` object to the built-in `http_request`
   tool for live API calls.
4. For natural-language writes, run `workflow` first. It emits ordered
   property metadata, lookup, operator confirmation, and write steps.
5. For writes, confirm the target record and intended field change, then pass
   either the exact `--grant` value or `--operator-grant`.
5. Use internal HubSpot IDs for write targets. If a name search returns multiple
   records, stop and ask for the exact record ID.
6. Use internal stage values for `dealstage`, `pipeline`, and
   `lifecyclestage`. Read `/crm/v3/properties/...` first when the internal
   value is unknown.

## Command Contract

Plan a request without authentication:

```bash
node skills/hubspot/hubspot.cjs --format json plan "Move the Acme Renewal deal to contractsent and add a follow-up task"
```

Build an ordered natural-language workflow:

```bash
node skills/hubspot/hubspot.cjs --format json workflow \
  "Move the Acme Renewal deal to contractsent and log a note saying 'Contract sent to legal'"
```

After selecting the exact deal id from search results, rerun with the record id
and exact grant:

```bash
node skills/hubspot/hubspot.cjs --format json workflow \
  "Move the Acme Renewal deal to contractsent" \
  --record-id 123456 \
  --grant approve-hubspot-deal-stage-update
```

List records:

```bash
node skills/hubspot/hubspot.cjs --format json http-request list contacts --limit 25
node skills/hubspot/hubspot.cjs --format json http-request list companies --property name --property domain
node skills/hubspot/hubspot.cjs --format json http-request list deals --properties dealname,dealstage,pipeline,amount
```

Search records:

```bash
node skills/hubspot/hubspot.cjs --format json http-request search contacts --query jane@example.com
node skills/hubspot/hubspot.cjs --format json http-request search companies --query acme
node skills/hubspot/hubspot.cjs --format json http-request search deals --query renewal
```

Read a record or properties:

```bash
node skills/hubspot/hubspot.cjs --format json http-request get deals 123456 --associations contacts,companies
node skills/hubspot/hubspot.cjs --format json http-request properties deals
node skills/hubspot/hubspot.cjs --format json http-request properties contacts
```

Update a deal stage after explicit grant:

```bash
node skills/hubspot/hubspot.cjs --format json http-request update-deal-stage 123456 \
  --stage contractsent \
  --properties-file /tmp/hubspot-deal-properties.json \
  --grant approve-hubspot-deal-stage-update
```

Update lifecycle stage after explicit grant:

```bash
node skills/hubspot/hubspot.cjs --format json http-request update-lifecycle-stage contacts 123456 \
  --stage marketingqualifiedlead \
  --properties-file /tmp/hubspot-contact-properties.json \
  --grant approve-hubspot-lifecycle-stage-update
```

Validate an internal option value from a saved properties response:

```bash
node skills/hubspot/hubspot.cjs --format json validate-option \
  --properties-file /tmp/hubspot-deal-properties.json \
  --property dealstage \
  --value contractsent
```

Create a note associated with a deal:

```bash
node skills/hubspot/hubspot.cjs --format json http-request create-note \
  --body "Spoke with Carla about legal review." \
  --associate-object deals \
  --associate-id 123456 \
  --grant approve-hubspot-note-create
```

Create a task associated with a contact:

```bash
node skills/hubspot/hubspot.cjs --format json http-request create-task \
  --subject "Send procurement packet" \
  --body "Follow up with pricing and security documentation." \
  --due 2026-05-20 \
  --associate-object contacts \
  --associate-id 987654 \
  --grant approve-hubspot-task-create
```

Run the offline eval suite:

```bash
node skills/hubspot/hubspot.cjs --format json eval-scenarios
```

Explain a HubSpot API error wrapper:

```bash
node skills/hubspot/hubspot.cjs --format json explain-error \
  --status 403 \
  --body '{"message":"missing scope crm.objects.deals.write"}'
```

## Working Rules

- Use `http_request`; do not use `curl` for HubSpot API calls when
  `http_request` is available.
- Never print, store in files, or include real HubSpot OAuth tokens in tool
  arguments or prose.
- Treat writes as amber operations and require exact operator grant in the
  current task.
- Use exact HubSpot record IDs for writes.
- Use HubSpot internal option values, not labels, for `dealstage`, `pipeline`,
  and `lifecyclestage`.
- Read CRM properties before changing a stage when the internal value is not
  known.
- Prefer passing saved property metadata with `--properties-file` for
  `dealstage` and `lifecyclestage` writes so the helper validates internal
  option values before emitting a write request.
- HubSpot lifecycle stage changes can be constrained by HubSpot's lifecycle
  ordering rules; if the API rejects a backwards move, report the upstream
  constraint instead of retrying with guessed values.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` so evals can verify the
  accounting contract.

## Eval Suite

The fixture at `evals/scenarios.json` contains 30 representative scenarios
across contact/company/deal reads, deal stage updates, lifecycle updates,
note logging, task creation, and compound requests.

## Validation

Run:

```bash
node skills/hubspot/hubspot.cjs --help
node skills/hubspot/hubspot.cjs --format json eval-scenarios
```
