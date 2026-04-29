---
name: salesforce
description: "Read Salesforce leads, contacts, opportunities, inspect schema/SOQL metadata, update opportunity stage/probability, and log calls, emails, or meetings with a deterministic gateway-proxied helper."
user-invocable: true
requires:
  bins:
    - python3
metadata:
  hybridclaw:
    category: development
    short_description: "Salesforce CRM reads and safe writes."
    tags:
      - salesforce
      - soql
      - crm
      - metadata
      - schema
---

# Salesforce

Use this skill for Salesforce CRM work from an org you can access with stored OAuth credentials.

## Scope

- global object discovery
- object describe / DDL-style metadata inspection
- relationship discovery for lookup, master-detail, and child links
- SOQL row queries
- Tooling API metadata queries
- lead, contact, and opportunity lookup
- opportunity stage/probability updates
- activity logging for calls, emails, and meetings on the right CRM record
- opinionated natural-language commands for common CRM workflows
- credential setup guidance using HybridClaw stored secrets

## Default Workflow

1. Start with read/plan commands. Do not mutate CRM state unless the user explicitly asks.
2. Run the bundled helper directly via bash in the current session:
   ```bash
   python3 skills/salesforce/scripts/salesforce_query.py ...
   ```
3. Use `plan` for natural-language requests when you need to inspect the API actions before execution.
4. Use `run` for supported opinionated workflows, for example "Move the Acme deal to Closed Won and log a call from today".
5. Use `find leads|contacts|opportunities` for business-row reads before a write target is ambiguous.
6. Use `objects`, `describe`, or `relations` before writing SOQL against an unfamiliar object.
7. Use `query` for row reads. Add a SOQL `LIMIT` unless the user explicitly needs a larger fetch.
8. Use `tooling-query` for metadata objects such as `CustomObject`, `FieldDefinition`, `ApexClass`, and flow metadata.
9. If login fails, confirm that `SF_FULL_PASSWORD` already includes any required Salesforce security token.

## Secret Refs

The helper routes all HTTP traffic through the HybridClaw gateway proxy.
OAuth credentials are sent as `<secret:NAME>` placeholders that the gateway
resolves server-side — real secret values never enter the Python process or
the agent context.

Required stored secrets:

- `SF_FULL_USERNAME`
- `SF_FULL_PASSWORD`
- `SF_FULL_CLIENTID`
- `SF_FULL_SECRET`
- `SF_DOMAIN` — `login` for production, `test` for sandbox

The gateway automatically captures the OAuth `access_token` from the login
response and stores it as `SF_ACCESS_TOKEN`; it also captures
`instance_url` as `SF_INSTANCE_URL`. The token never enters the Python process
or the agent context. Subsequent API calls reference it via `bearerSecretName`,
so the gateway injects the bearer token server-side.

Ask the user to set them once from a local HybridClaw session:

```text
/secret set SF_FULL_USERNAME you@example.com
/secret set SF_FULL_PASSWORD <password-plus-token>
/secret set SF_FULL_CLIENTID <connected-app-client-id>
/secret set SF_FULL_SECRET <connected-app-client-secret>
/secret set SF_DOMAIN login
```

Shell-side equivalent:

```bash
hybridclaw secret set SF_FULL_USERNAME you@example.com
hybridclaw secret set SF_FULL_PASSWORD '<password-plus-token>'
hybridclaw secret set SF_FULL_CLIENTID '<connected-app-client-id>'
hybridclaw secret set SF_FULL_SECRET '<connected-app-client-secret>'
hybridclaw secret set SF_DOMAIN login
```

## Command Contract

Plan a natural-language CRM request without authentication:

```bash
python3 skills/salesforce/scripts/salesforce_query.py --format json plan "Move the Acme deal to Closed Won and log a call from today"
```

Execute a supported natural-language CRM request:

```bash
python3 skills/salesforce/scripts/salesforce_query.py run "Move the Acme deal to Closed Won and log a call from today"
```

List objects:

```bash
python3 skills/salesforce/scripts/salesforce_query.py objects --search Account
```

Describe an object:

```bash
python3 skills/salesforce/scripts/salesforce_query.py describe Account
```

Show parent and child relationships:

```bash
python3 skills/salesforce/scripts/salesforce_query.py relations Opportunity
```

Query rows:

```bash
python3 skills/salesforce/scripts/salesforce_query.py query "SELECT Id, Name FROM Account LIMIT 10"
```

Query Tooling API metadata:

```bash
python3 skills/salesforce/scripts/salesforce_query.py tooling-query "SELECT Id, DeveloperName FROM CustomObject LIMIT 20"
```

Find CRM records:

```bash
python3 skills/salesforce/scripts/salesforce_query.py find leads --search Acme
python3 skills/salesforce/scripts/salesforce_query.py find contacts --search "Jane"
python3 skills/salesforce/scripts/salesforce_query.py find opportunities --search Acme --open-only
```

Update an Opportunity:

```bash
python3 skills/salesforce/scripts/salesforce_query.py update-opportunity "Acme Renewal" --stage "Closed Won"
python3 skills/salesforce/scripts/salesforce_query.py update-opportunity 006000000000001AAA --stage "Negotiation/Review" --probability 80
```

Log activities:

```bash
python3 skills/salesforce/scripts/salesforce_query.py log-activity call "Acme Renewal" --object opportunity --subject "Discovery follow-up" --date today
python3 skills/salesforce/scripts/salesforce_query.py log-activity email "Jane Rivera" --object contact --subject "Sent pricing notes" --date today
python3 skills/salesforce/scripts/salesforce_query.py log-activity meeting "BigCo" --object account --subject "Implementation review" --date 2026-05-01 --duration-minutes 45
```

Emit JSON for downstream tooling:

```bash
python3 skills/salesforce/scripts/salesforce_query.py --format json describe Account
```

## Working Rules

- Keep the default posture read-first and plan-first.
- Mutations are limited to Opportunity `StageName`/`Probability` updates and Task/Event creation for calls, emails, or meetings.
- Use exact Salesforce ids when available. If resolving by name returns multiple matches, stop and ask for the exact record.
- Never print secrets, dump the full environment, or commit auth profile files.
- Treat `SF_DOMAIN` as one of: `login` (production) or `test` (sandbox).
- Prefer `--format json` when another tool or script needs the response.
- Treat raw `query` and `tooling-query` SOQL as full-credential reads: any caller with gateway access can read arbitrary Salesforce data allowed by the stored OAuth user.
- For large tables, narrow the selected columns and use a SOQL `LIMIT` first.
- The helper strips Salesforce `attributes` objects by default to keep row output compact. Use `--keep-attributes` only when the caller explicitly needs them.
- If the API route is disabled or insufficient, explain that and fall back to browser or admin guidance instead of guessing.
- Cost per assistant run is recorded by HybridClaw `UsageTotals` from normal model usage events; helper output includes `costMeasurement.system = "UsageTotals"` so evals can verify the accounting contract.

## Eval Suite

Run the offline natural-language planner scenarios:

```bash
python3 skills/salesforce/scripts/salesforce_query.py --format json eval-scenarios
```

The fixture at `evals/scenarios.json` contains 30 scenarios across lead/contact/opportunity reads, Opportunity updates, activity logging, and compound commands.

## References

- Query patterns, metadata notes, and auth examples: [references/metadata-and-queries.md](references/metadata-and-queries.md)

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/salesforce
python3 skills/salesforce/scripts/salesforce_query.py --help
python3 skills/salesforce/scripts/salesforce_query.py --format json eval-scenarios
```
