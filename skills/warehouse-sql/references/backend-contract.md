# Warehouse SQL Backend Contract

The `warehouse-sql` helper owns schema-cache format, SQL safety review, evals,
and execution dispatch. SQLite uses Python stdlib. Production warehouses use
optional Python drivers or an operator-provided connector command.

## Cache Shape

```json
{
  "cacheVersion": 1,
  "backend": "postgres",
  "profile": "analytics",
  "refreshedAt": "2026-04-29T10:30:00Z",
  "tables": [
    {
      "name": "orders",
      "schema": "public",
      "columns": [
        {"name": "o_orderkey", "type": "INTEGER", "nullable": false}
      ],
      "primaryKeys": [],
      "foreignKeys": [
        {
          "columns": ["o_custkey"],
          "referencesTable": "customer",
          "referencesColumns": ["c_custkey"]
        }
      ]
    }
  ]
}
```

## Introspection Queries

Use:

```bash
python3 skills/warehouse-sql/scripts/warehouse_sql.py --format json backend-contract --backend postgres
```

The command emits backend-specific introspection SQL for:

- table and view discovery
- column names/types/nullability
- foreign keys where the backend exposes them through information schema

`primaryKeys` is always present in the cache shape, but may be empty for
non-SQLite backends. Consumers should not require primary-key metadata for
warehouse backends.

## Connector Command Protocol

Set `HYBRIDCLAW_WAREHOUSE_SQL_<BACKEND>_COMMAND` or pass `--backend-command`.
The command receives SQL on stdin and in `WAREHOUSE_SQL_QUERY`, then emits one
of:

- a JSON row array
- an object with `rows: [...]`
- CSV with headers

This lets operators route execution through existing secret stores and network
policy without exposing credentials to the agent context.
