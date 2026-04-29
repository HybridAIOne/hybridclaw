---
name: warehouse-sql
description: "Review and run read-only natural-language SQL against a customer data warehouse with cached schema introspection and explicit write grants."
user-invocable: true
requires:
  bins:
    - python3
metadata:
  hybridclaw:
    category: development
    short_description: "Natural-language SQL for warehouses."
    tags:
      - sql
      - warehouse
      - analytics
      - postgres
      - clickhouse
      - bigquery
      - snowflake
---

# Warehouse SQL

Use this skill when the user asks natural-language questions of a data
warehouse, analytics database, or TPC-H-style reporting dataset.

## Scope

- schema introspection for SQLite eval databases and pluggable Postgres,
  ClickHouse, BigQuery, and Snowflake backends
- cached schema summaries with explicit refresh commands for scheduled runs
- reproducible TPC-H-style evaluation cases for generated SQL
- deterministic SQL safety review before execution
- read-only execution by default
- write detection and explicit per-skill grant checks before any mutation

## Default Workflow

1. Refresh or read cached schema before asking the model to draft SQL:
   ```bash
   python3 skills/warehouse-sql/scripts/warehouse_sql.py --format json schema --backend sqlite --database ./warehouse.db
   ```
2. Have the model draft SQL using the cached schema, then review it before execution:
   ```bash
   python3 skills/warehouse-sql/scripts/warehouse_sql.py --format json review "SELECT c_name FROM customer LIMIT 10"
   ```
3. Return the SQL to the user before execution when the user asks for review,
   when the query is broad, or when the result could expose sensitive business
   data.
4. Execute only after the SQL review passes:
   ```bash
   python3 skills/warehouse-sql/scripts/warehouse_sql.py --format json query --backend sqlite --database ./warehouse.db --execute "SELECT c_name FROM customer LIMIT 10"
   ```

## Backend Contract

Supported backend names:

- `sqlite` — executable through Python stdlib; used by the bundled eval suite
- `postgres` — `psycopg` driver, or a connector command
- `clickhouse` — `clickhouse-connect` driver, or a connector command
- `bigquery` — `google-cloud-bigquery` driver, or a connector command
- `snowflake` — `snowflake-connector-python` driver, or a connector command

For non-SQLite warehouses, install the backend driver package in the skill
runtime or provide `--backend-command` / `HYBRIDCLAW_WAREHOUSE_SQL_<BACKEND>_COMMAND`.
Connector commands read SQL on stdin and emit a JSON row array, `{"rows": [...]}`
or CSV with headers. Do not invent credentials.

BigQuery schema introspection requires `--bigquery-dataset` or
`HYBRIDCLAW_WAREHOUSE_SQL_BIGQUERY_DATASET`. Set
`--bigquery-project` / `HYBRIDCLAW_WAREHOUSE_SQL_BIGQUERY_PROJECT` when the
dataset is not in the default project.

## Schema Cache

The helper writes schema cache files outside the repo by default at:

```text
~/.hybridclaw/warehouse-sql/schema-cache
```

Use `--cache-dir` for tests or customer-specific workspaces. Use `--refresh` to
force re-introspection. Use `schedule-refresh` to register the refresh with the
HybridClaw gateway scheduler:

```bash
python3 skills/warehouse-sql/scripts/warehouse_sql.py --format json schedule-refresh --backend postgres --profile analytics --every "0 */6 * * *"
```

Scheduled refreshes default to `last-channel` delivery. Use
`--delivery-kind channel --delivery-to <channel-id>` only when the target
channel id is known.

Set `HYBRIDCLAW_GATEWAY_TOKEN` or `GATEWAY_API_TOKEN` in the environment for
production scheduler registration. `--gateway-token` is supported for tests, but
tokens passed as CLI arguments can be visible in process listings.

## Read/Write Rules

- Default posture is read-only. `SELECT`, `WITH`, and `EXPLAIN` are allowed.
- Mutating SQL is blocked unless all of these are true:
  - the user explicitly requested a write
  - the command includes `--allow-write`
  - the environment contains `HYBRIDCLAW_WAREHOUSE_SQL_WRITE_GRANT`
  - `--write-grant` exactly matches that environment value
- Do not set or reveal the write grant in chat. Treat it like an operator
  capability, not a user-facing token.
- Even with a write grant, explain the mutation and ask for confirmation before
  running it unless the user already gave a concrete write instruction.

## SQL Review Rules

Before execution, check:

- single statement only
- read-only unless the explicit write grant path is used
- selected columns are narrow enough for the task
- `LIMIT` is present for exploratory row reads
- joins use known keys from the schema cache
- date and tenant filters are present when the question implies scope

The helper emits a `review` object with safety status and findings. Treat that
as a deterministic guardrail; still perform model review for business meaning.

## Eval Suite

Run the offline TPC-H-style scenarios:

```bash
python3 skills/warehouse-sql/scripts/warehouse_sql.py --format json eval-scenarios
```

The fixture at `evals/tpch_tiny.sql` contains a tiny public-schema-compatible
dataset using TPC-H-style tables (`customer`, `orders`, `lineitem`, `supplier`,
`part`, `nation`). The scenario file at `evals/tpch_scenarios.json` verifies
read-only review and execution against deterministic answers.

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/warehouse-sql
python3 skills/warehouse-sql/scripts/warehouse_sql.py --help
python3 skills/warehouse-sql/scripts/warehouse_sql.py --format json eval-scenarios
```
