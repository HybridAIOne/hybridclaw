---
name: salesforce
description: "Inspect Salesforce objects, fields, relationships, Tooling API metadata, and SOQL rows with a deterministic Python helper. Use when the user asks about Salesforce schema, DDL-like metadata, joins, record lookups, or org structure."
user-invocable: true
requires:
  bins:
    - python3
metadata:
  hybridclaw:
    category: development
    short_description: "Inspect Salesforce schema and SOQL data."
    tags:
      - salesforce
      - soql
      - crm
      - metadata
      - schema
---

# Salesforce

Use this skill for read-only Salesforce exploration from an org you can access with API credentials.

## Scope

- global object discovery
- object describe / DDL-style metadata inspection
- relationship discovery for lookup, master-detail, and child links
- SOQL row queries
- Tooling API metadata queries
- credential setup guidance using HybridClaw stored secrets

## Default Workflow

1. Start read-only. Do not create, update, delete, or deploy anything unless the user explicitly asks.
2. Run the bundled helper directly via bash in the current session:
   ```bash
   python3 skills/salesforce/scripts/salesforce_query.py ...
   ```
3. Use `objects` or `describe` before writing SOQL against an unfamiliar object.
4. Use `relations` when the user asks how objects join or which foreign keys exist.
5. Use `query` for row reads. Add a SOQL `LIMIT` unless the user explicitly needs a larger fetch.
6. Use `tooling-query` for metadata objects such as `CustomObject`, `FieldDefinition`, `ApexClass`, and flow metadata.
7. If login fails, confirm that `SF_FULL_PASSWORD` already includes any required Salesforce security token.

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
response and stores it as `SF_ACCESS_TOKEN` — the token never enters the
Python process or the agent context. Subsequent API calls reference it via
`bearerSecretName`.

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

Emit JSON for downstream tooling:

```bash
python3 skills/salesforce/scripts/salesforce_query.py --format json describe Account
```

## Working Rules

- Keep the default posture read-only.
- Never print secrets, dump the full environment, or commit auth profile files.
- Treat `SF_DOMAIN` as one of: `login` (production) or `test` (sandbox).
- Prefer `--format json` when another tool or script needs the response.
- For large tables, narrow the selected columns and use a SOQL `LIMIT` first.
- The helper strips Salesforce `attributes` objects by default to keep row output compact. Use `--keep-attributes` only when the caller explicitly needs them.
- If the API route is disabled or insufficient, explain that and fall back to browser or admin guidance instead of guessing.

## References

- Query patterns, metadata notes, and auth examples: [references/metadata-and-queries.md](references/metadata-and-queries.md)

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/salesforce
python3 skills/salesforce/scripts/salesforce_query.py --help
```
