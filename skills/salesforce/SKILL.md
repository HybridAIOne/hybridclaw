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
- credential setup guidance using HybridClaw-style env secret refs

## Default Workflow

1. Start read-only. Do not create, update, delete, or deploy anything unless the user explicitly asks.
2. Prefer the bundled helper:
   ```bash
   python3 skills/salesforce/scripts/salesforce_query.py ...
   ```
3. Use `objects` or `describe` before writing SOQL against an unfamiliar object.
4. Use `relations` when the user asks how objects join or which foreign keys exist.
5. Use `query` for row reads. Add a SOQL `LIMIT` unless the user explicitly needs a larger fetch.
6. Use `tooling-query` for metadata objects such as `CustomObject`, `FieldDefinition`, `ApexClass`, and flow metadata.
7. If login fails, confirm that `SF_FULL_PASSWORD` already includes any required Salesforce security token.

## Secret Refs

By default, the helper resolves these env secret refs internally:

- `SF_FULL_USERNAME`
- `SF_FULL_PASSWORD`
- `SF_FULL_CLIENTID`
- `SF_FULL_SECRET`
- `SF_DOMAIN`

No config file is required if those environment variables are present.

To override the default org or make the auth source explicit, create an untracked JSON file such as `/tmp/salesforce-profile.json`:

```json
{
  "auth": {
    "username": { "source": "env", "id": "SF_FULL_USERNAME" },
    "password": { "source": "env", "id": "SF_FULL_PASSWORD" },
    "client_id": { "source": "env", "id": "SF_FULL_CLIENTID" },
    "client_secret": { "source": "env", "id": "SF_FULL_SECRET" },
    "domain": { "source": "env", "id": "SF_DOMAIN" }
  },
  "api_version": "latest"
}
```

The helper also accepts `${ENV_VAR}` shorthand in the same fields. Keep profile files out of git.

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

Use a custom profile file:

```bash
python3 skills/salesforce/scripts/salesforce_query.py --config /tmp/salesforce-profile.json query "SELECT Id FROM Contact LIMIT 5"
```

## Working Rules

- Keep the default posture read-only.
- Never print secrets, dump the full environment, or commit auth profile files.
- Treat `SF_DOMAIN` as one of: `login`, `test`, a Salesforce host name, or a full `https://...` base URL.
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
