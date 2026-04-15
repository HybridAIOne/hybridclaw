# Salesforce Query Patterns

Use the bundled helper for read-only org inspection:

```bash
python3 skills/salesforce/scripts/salesforce_query.py ...
```

## Auth Model

The helper defaults to these store-backed secret refs:

- `SF_FULL_USERNAME`
- `SF_FULL_PASSWORD`
- `SF_FULL_CLIENTID`
- `SF_FULL_SECRET`
- `SF_DOMAIN`

Primary setup flow:

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

`SF_FULL_PASSWORD` should already include the Salesforce security token when the org requires one.

`SF_DOMAIN` can be:

- `login` for production login
- `test` for sandbox login
- a host like `mydomain.my.salesforce.com`
- a full URL like `https://mydomain.my.salesforce.com`

If you need an explicit profile file, keep it untracked:

```json
{
  "auth": {
    "username": { "source": "store", "id": "SF_FULL_USERNAME" },
    "password": { "source": "store", "id": "SF_FULL_PASSWORD" },
    "client_id": { "source": "store", "id": "SF_FULL_CLIENTID" },
    "client_secret": { "source": "store", "id": "SF_FULL_SECRET" },
    "domain": { "source": "store", "id": "SF_DOMAIN" }
  },
  "api_version": "latest"
}
```

`${ENV_VAR}` shorthand and `{ "source": "env", "id": "ENV_VAR" }` are also accepted in those fields.

## Which Command To Use

- `objects`: list available sObjects and filter by search term
- `describe <Object>`: inspect fields, required flags, reference targets, and child relationships
- `relations <Object>`: focus on parent lookup/master-detail links plus incoming child relationships
- `query "<SOQL>"`: fetch record rows through the standard query API
- `tooling-query "<SOQL>"`: query metadata objects through the Tooling API

## Useful Examples

List matching objects:

```bash
python3 skills/salesforce/scripts/salesforce_query.py objects --search Opportunity
```

Inspect schema:

```bash
python3 skills/salesforce/scripts/salesforce_query.py describe OpportunityLineItem
```

Inspect joins:

```bash
python3 skills/salesforce/scripts/salesforce_query.py relations Case
```

Read rows:

```bash
python3 skills/salesforce/scripts/salesforce_query.py query "SELECT Id, Name, Owner.Name FROM Account LIMIT 10"
```

Read child rows:

```bash
python3 skills/salesforce/scripts/salesforce_query.py query "SELECT Id, Name, (SELECT Id, LastName FROM Contacts LIMIT 5) FROM Account LIMIT 3"
```

Query metadata:

```bash
python3 skills/salesforce/scripts/salesforce_query.py tooling-query "SELECT QualifiedApiName, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Account' LIMIT 20"
```

Emit JSON:

```bash
python3 skills/salesforce/scripts/salesforce_query.py --format json query "SELECT Id, Name FROM Account LIMIT 5"
```

## Query Hygiene

- Start with explicit column lists. Avoid `SELECT *` style thinking; SOQL does not support it anyway.
- Add `LIMIT` unless you intentionally need pagination across many records.
- Prefer `describe` before building joins against unfamiliar objects.
- Use `tooling-query` for metadata records, not business rows.
- Keep `--keep-attributes` off unless you explicitly need Salesforce record type metadata in the response.
