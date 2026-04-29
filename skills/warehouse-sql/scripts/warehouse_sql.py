#!/usr/bin/env python3
# ruff: noqa: INP001
"""Natural-language warehouse SQL helper.

The helper owns schema-cache management, SQL safety review, warehouse execution,
scheduler registration, and the bundled TPC-H-style eval runner.
"""

from __future__ import annotations

import argparse
import csv
import hmac
import hashlib
import io
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request

CACHE_VERSION = 1
DEFAULT_CACHE_TTL_SECONDS = 6 * 60 * 60
DEFAULT_MAX_ROWS = 200
WRITE_GRANT_ENV = "HYBRIDCLAW_WAREHOUSE_SQL_WRITE_GRANT"
DEFAULT_GATEWAY_URL = "http://127.0.0.1:9090"
CONNECTOR_ENV_PASSTHROUGH = {
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
    "TMPDIR",
}

SKILL_DIR = Path(__file__).resolve().parent.parent
EVAL_SCENARIOS_PATH = SKILL_DIR / "evals" / "tpch_scenarios.json"
TPC_H_FIXTURE_PATH = SKILL_DIR / "evals" / "tpch_tiny.sql"

BACKENDS = {"sqlite", "postgres", "clickhouse", "bigquery", "snowflake"}
READ_ONLY_STARTERS = {"select", "with", "explain"}
MUTATING_KEYWORDS = {
    "alter",
    "attach",
    "call",
    "copy",
    "create",
    "delete",
    "detach",
    "drop",
    "execute",
    "grant",
    "insert",
    "load",
    "merge",
    "put",
    "remove",
    "replace",
    "revoke",
    "truncate",
    "update",
    "vacuum",
}

BACKEND_INTROSPECTION_SQL: dict[str, dict[str, str | None]] = {
    "postgres": {
        "tables": """
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name;
""".strip(),
        "columns": """
SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name, ordinal_position;
""".strip(),
        "foreignKeys": """
SELECT tc.table_schema, tc.table_name, kcu.column_name,
       ccu.table_schema AS references_schema,
       ccu.table_name AS references_table,
       ccu.column_name AS references_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position;
""".strip(),
    },
    "clickhouse": {
        "tables": """
SELECT database AS table_schema, name AS table_name, engine AS table_type
FROM system.tables
WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
ORDER BY database, name;
""".strip(),
        "columns": """
SELECT database AS table_schema, table AS table_name, name AS column_name,
       type AS data_type, position AS ordinal_position
FROM system.columns
WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
ORDER BY database, table, position;
""".strip(),
        "foreignKeys": None,
    },
    "bigquery": {
        "tables": """
SELECT table_catalog, table_schema, table_name, table_type
FROM `<project>.<dataset>.INFORMATION_SCHEMA.TABLES`
ORDER BY table_schema, table_name;
""".strip(),
        "columns": """
SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
FROM `<project>.<dataset>.INFORMATION_SCHEMA.COLUMNS`
ORDER BY table_schema, table_name, ordinal_position;
""".strip(),
        "foreignKeys": None,
    },
    "snowflake": {
        "tables": """
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema <> 'INFORMATION_SCHEMA'
ORDER BY table_schema, table_name;
""".strip(),
        "columns": """
SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
FROM information_schema.columns
WHERE table_schema <> 'INFORMATION_SCHEMA'
ORDER BY table_schema, table_name, ordinal_position;
""".strip(),
        "foreignKeys": """
SELECT fk_tco.table_schema, fk_tco.table_name, fk_col.column_name,
       pk_tco.table_schema AS references_schema,
       pk_tco.table_name AS references_table,
       pk_col.column_name AS references_column
FROM information_schema.referential_constraints rco
JOIN information_schema.table_constraints fk_tco
  ON rco.constraint_name = fk_tco.constraint_name
 AND rco.constraint_schema = fk_tco.table_schema
JOIN information_schema.table_constraints pk_tco
  ON rco.unique_constraint_name = pk_tco.constraint_name
 AND rco.unique_constraint_schema = pk_tco.table_schema
JOIN information_schema.key_column_usage fk_col
  ON fk_col.constraint_name = fk_tco.constraint_name
 AND fk_col.constraint_schema = fk_tco.table_schema
JOIN information_schema.key_column_usage pk_col
  ON pk_col.constraint_name = pk_tco.constraint_name
 AND pk_col.constraint_schema = pk_tco.table_schema
 AND pk_col.ordinal_position = fk_col.ordinal_position
ORDER BY fk_tco.table_schema, fk_tco.table_name, fk_col.ordinal_position;
""".strip(),
    },
}


class WarehouseSqlError(RuntimeError):
    """Raised for user-facing helper failures."""


@dataclass
class ReviewResult:
    status: str
    read_only: bool
    statements: list[str]
    findings: list[str]
    requires_write_grant: bool


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def default_cache_dir() -> Path:
    return Path.home() / ".hybridclaw" / "warehouse-sql" / "schema-cache"


def stable_cache_key(backend: str, profile: str, database: str | None) -> str:
    raw = json.dumps(
        {"backend": backend, "profile": profile, "database": database or ""},
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def cache_path(cache_dir: Path, backend: str, profile: str, database: str | None) -> Path:
    return cache_dir / f"{backend}-{profile}-{stable_cache_key(backend, profile, database)}.json"


def emit(payload: Any, fmt: str) -> None:
    if fmt == "json":
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    if isinstance(payload, str):
        print(payload)
        return
    print(json.dumps(payload, indent=2, sort_keys=True))


def ensure_backend(backend: str) -> None:
    if backend not in BACKENDS:
        raise WarehouseSqlError(
            f"unsupported backend '{backend}'. Choose one of: {', '.join(sorted(BACKENDS))}"
        )


def connect_sqlite(database: str | None) -> sqlite3.Connection:
    if not database:
        raise WarehouseSqlError("--database is required for sqlite commands")
    path = Path(database).expanduser()
    if not path.exists():
        raise WarehouseSqlError(f"sqlite database not found: {path}")
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def backend_command_env_name(backend: str) -> str:
    return f"HYBRIDCLAW_WAREHOUSE_SQL_{backend.upper().replace('-', '_')}_COMMAND"


def resolve_backend_command(args: argparse.Namespace) -> str:
    explicit = str(getattr(args, "backend_command", "") or "").strip()
    if explicit:
        return explicit
    return os.environ.get(backend_command_env_name(args.backend), "").strip()


def connector_command_env(args: argparse.Namespace, sql: str) -> dict[str, str]:
    backend_prefix = f"HYBRIDCLAW_WAREHOUSE_SQL_{args.backend.upper().replace('-', '_')}_"
    env: dict[str, str] = {}
    for name in CONNECTOR_ENV_PASSTHROUGH:
        value = os.environ.get(name)
        if value is not None:
            env[name] = value
    for name, value in os.environ.items():
        if not name.startswith(backend_prefix):
            continue
        if name in {WRITE_GRANT_ENV, backend_command_env_name(args.backend)}:
            continue
        env[name] = value
    env.update(
        {
            "WAREHOUSE_SQL_BACKEND": args.backend,
            "WAREHOUSE_SQL_PROFILE": str(getattr(args, "profile", "default") or "default"),
            "WAREHOUSE_SQL_QUERY": sql,
        }
    )
    return env


def parse_rows_payload(raw: str) -> list[dict[str, Any]]:
    text = raw.strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        reader = csv.DictReader(io.StringIO(text))
        return [dict(row) for row in reader]

    if isinstance(parsed, list):
        return [row for row in parsed if isinstance(row, dict)]
    if isinstance(parsed, dict):
        rows = parsed.get("rows")
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    raise WarehouseSqlError("Backend command must emit a JSON row array, {'rows': [...]}, or CSV with headers.")


def run_backend_command(args: argparse.Namespace, sql: str) -> list[dict[str, Any]]:
    command = resolve_backend_command(args)
    if not command:
        raise WarehouseSqlError(
            f"{args.backend} requires {backend_command_env_name(args.backend)} or --backend-command, or an installed Python driver with the required environment."
        )
    env = connector_command_env(args, sql)
    try:
        result = subprocess.run(
            shlex.split(command),
            input=sql,
            text=True,
            capture_output=True,
            check=False,
            env=env,
            timeout=max(1, int(getattr(args, "timeout_seconds", 60) or 60)),
        )
    except FileNotFoundError as exc:
        raise WarehouseSqlError(f"Backend command not found: {command}") from exc
    except subprocess.TimeoutExpired as exc:
        raise WarehouseSqlError(f"Backend command timed out after {exc.timeout}s.") from exc

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise WarehouseSqlError(f"Backend command failed: {detail}")
    return parse_rows_payload(result.stdout)


def run_postgres_driver(args: argparse.Namespace, sql: str) -> list[dict[str, Any]]:
    dsn = os.environ.get("HYBRIDCLAW_WAREHOUSE_SQL_POSTGRES_DSN", "").strip()
    if not dsn:
        raise WarehouseSqlError("Postgres requires HYBRIDCLAW_WAREHOUSE_SQL_POSTGRES_DSN or a backend command.")
    try:
        import psycopg  # type: ignore
        from psycopg.rows import dict_row  # type: ignore
    except ImportError as exc:
        raise WarehouseSqlError("Postgres driver not installed. Install psycopg or configure a backend command.") from exc

    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            if cur.description is None:
                conn.commit()
                return [{"affected_rows": cur.rowcount}]
            return [dict(row) for row in cur.fetchall()]


def run_clickhouse_driver(args: argparse.Namespace, sql: str) -> list[dict[str, Any]]:
    try:
        import clickhouse_connect  # type: ignore
    except ImportError as exc:
        raise WarehouseSqlError("ClickHouse driver not installed. Install clickhouse-connect or configure a backend command.") from exc

    client = clickhouse_connect.get_client(
        host=os.environ.get("HYBRIDCLAW_WAREHOUSE_SQL_CLICKHOUSE_HOST", "localhost"),
        port=int(os.environ.get("HYBRIDCLAW_WAREHOUSE_SQL_CLICKHOUSE_PORT", "8123")),
        username=os.environ.get("HYBRIDCLAW_WAREHOUSE_SQL_CLICKHOUSE_USER", "default"),
        password=os.environ.get("HYBRIDCLAW_WAREHOUSE_SQL_CLICKHOUSE_PASSWORD", ""),
        database=os.environ.get("HYBRIDCLAW_WAREHOUSE_SQL_CLICKHOUSE_DATABASE", "default"),
        secure=os.environ.get("HYBRIDCLAW_WAREHOUSE_SQL_CLICKHOUSE_SECURE", "").lower() in {"1", "true", "yes"},
    )
    result = client.query(sql)
    return [dict(zip(result.column_names, row)) for row in result.result_rows]


def run_bigquery_driver(args: argparse.Namespace, sql: str) -> list[dict[str, Any]]:
    try:
        from google.cloud import bigquery  # type: ignore
    except ImportError as exc:
        raise WarehouseSqlError("BigQuery driver not installed. Install google-cloud-bigquery or configure a backend command.") from exc

    project = os.environ.get("HYBRIDCLAW_WAREHOUSE_SQL_BIGQUERY_PROJECT", "").strip() or None
    client = bigquery.Client(project=project)
    return [dict(row.items()) for row in client.query(sql).result()]


def run_snowflake_driver(args: argparse.Namespace, sql: str) -> list[dict[str, Any]]:
    try:
        import snowflake.connector  # type: ignore
    except ImportError as exc:
        raise WarehouseSqlError("Snowflake driver not installed. Install snowflake-connector-python or configure a backend command.") from exc

    required = {
        "account": "HYBRIDCLAW_WAREHOUSE_SQL_SNOWFLAKE_ACCOUNT",
        "user": "HYBRIDCLAW_WAREHOUSE_SQL_SNOWFLAKE_USER",
        "password": "HYBRIDCLAW_WAREHOUSE_SQL_SNOWFLAKE_PASSWORD",
    }
    kwargs: dict[str, str] = {}
    for key, env_name in required.items():
        value = os.environ.get(env_name, "").strip()
        if not value:
            raise WarehouseSqlError(f"Snowflake requires {env_name} or a backend command.")
        kwargs[key] = value
    for key, env_name in {
        "warehouse": "HYBRIDCLAW_WAREHOUSE_SQL_SNOWFLAKE_WAREHOUSE",
        "database": "HYBRIDCLAW_WAREHOUSE_SQL_SNOWFLAKE_DATABASE",
        "schema": "HYBRIDCLAW_WAREHOUSE_SQL_SNOWFLAKE_SCHEMA",
        "role": "HYBRIDCLAW_WAREHOUSE_SQL_SNOWFLAKE_ROLE",
    }.items():
        value = os.environ.get(env_name, "").strip()
        if value:
            kwargs[key] = value

    conn = snowflake.connector.connect(**kwargs)
    try:
        cur = conn.cursor(snowflake.connector.DictCursor)
        try:
            cur.execute(sql)
            rows = cur.fetchall() if cur.description else [{"affected_rows": cur.rowcount}]
            return [dict(row) for row in rows]
        finally:
            cur.close()
    finally:
        conn.close()


def run_backend_sql(args: argparse.Namespace, sql: str) -> list[dict[str, Any]]:
    command = resolve_backend_command(args)
    if command:
        return run_backend_command(args, sql)
    if args.backend == "postgres":
        return run_postgres_driver(args, sql)
    if args.backend == "clickhouse":
        return run_clickhouse_driver(args, sql)
    if args.backend == "bigquery":
        return run_bigquery_driver(args, sql)
    if args.backend == "snowflake":
        return run_snowflake_driver(args, sql)
    raise WarehouseSqlError(f"No executable adapter for backend '{args.backend}'.")


def row_text(row: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value is not None:
            return str(value)
    lower = {str(key).lower(): value for key, value in row.items()}
    for key in keys:
        value = lower.get(key.lower())
        if value is not None:
            return str(value)
    return ""


def row_bool(row: dict[str, Any], key: str, fallback: bool = True) -> bool:
    raw = row_text(row, key)
    if not raw:
        return fallback
    return raw.strip().lower() not in {"no", "false", "0", "n"}


def row_int(row: dict[str, Any], key: str, fallback: int = 0) -> int:
    raw = row_text(row, key)
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return fallback


def make_table_entry(schema: str, name: str, table_type: str = "table") -> dict[str, Any]:
    return {
        "name": name,
        "schema": schema,
        "type": table_type,
        "columns": [],
        "primaryKeys": [],
        "foreignKeys": [],
    }


def normalize_backend_schema(args: argparse.Namespace) -> dict[str, Any]:
    table_rows = run_backend_sql(args, BACKEND_INTROSPECTION_SQL[args.backend]["tables"])
    column_rows = run_backend_sql(args, BACKEND_INTROSPECTION_SQL[args.backend]["columns"])
    fk_sql = BACKEND_INTROSPECTION_SQL[args.backend]["foreignKeys"]
    fk_rows = run_backend_sql(args, fk_sql) if fk_sql is not None else []

    tables: dict[tuple[str, str], dict[str, Any]] = {}
    for row in table_rows:
        schema = row_text(row, "table_schema", "database", "schema") or "default"
        name = row_text(row, "table_name", "name")
        if not name:
            continue
        tables[(schema, name)] = make_table_entry(
            schema,
            name,
            row_text(row, "table_type", "engine", "type") or "table",
        )

    for row in column_rows:
        schema = row_text(row, "table_schema", "database", "schema") or "default"
        table = row_text(row, "table_name", "table")
        column = row_text(row, "column_name", "name")
        if not table or not column:
            continue
        entry = tables.setdefault((schema, table), make_table_entry(schema, table))
        entry["columns"].append(
            {
                "name": column,
                "type": row_text(row, "data_type", "type") or "UNKNOWN",
                "nullable": row_bool(row, "is_nullable", True),
                "ordinal": row_int(row, "ordinal_position", len(entry["columns"]) + 1),
            }
        )

    for row in fk_rows:
        schema = row_text(row, "table_schema", "database", "schema") or "default"
        table = row_text(row, "table_name", "table")
        column = row_text(row, "column_name", "name")
        ref_table = row_text(row, "references_table", "foreign_table_name")
        ref_column = row_text(row, "references_column", "foreign_column_name")
        if not table or not column or not ref_table:
            continue
        entry = tables.setdefault((schema, table), make_table_entry(schema, table))
        entry["foreignKeys"].append(
            {
                "columns": [column],
                "referencesTable": ref_table,
                "referencesColumns": [ref_column] if ref_column else [],
            }
        )

    return {
        "cacheVersion": CACHE_VERSION,
        "backend": args.backend,
        "profile": args.profile,
        "refreshedAt": utc_now(),
        "tables": sorted(tables.values(), key=lambda table: (table["schema"], table["name"])),
    }


def sqlite_schema(database: str) -> dict[str, Any]:
    with connect_sqlite(database) as conn:
        tables = []
        table_rows = conn.execute(
            """
            SELECT name, type, sql
            FROM sqlite_master
            WHERE type IN ('table', 'view')
              AND name NOT LIKE 'sqlite_%'
            ORDER BY name
            """
        ).fetchall()
        for table_row in table_rows:
            table_name = table_row["name"]
            table_info_rows = [
                dict(row)
                for row in conn.execute(f"PRAGMA table_info({quote_identifier(table_name)})")
            ]
            columns = [
                {
                    "name": row["name"],
                    "type": row["type"] or "UNKNOWN",
                    "nullable": not bool(row["notnull"]),
                    "default": row["dflt_value"],
                    "ordinal": row["cid"] + 1,
                }
                for row in table_info_rows
            ]
            primary_keys = [
                column["name"]
                for column in sorted(table_info_rows, key=lambda row: row["pk"])
                if column["pk"]
            ]
            foreign_keys = [
                {
                    "columns": [row["from"]],
                    "referencesTable": row["table"],
                    "referencesColumns": [row["to"]],
                }
                for row in conn.execute(f"PRAGMA foreign_key_list({quote_identifier(table_name)})")
            ]
            tables.append(
                {
                    "name": table_name,
                    "schema": "main",
                    "type": table_row["type"],
                    "columns": columns,
                    "primaryKeys": primary_keys,
                    "foreignKeys": foreign_keys,
                }
            )
    return {
        "cacheVersion": CACHE_VERSION,
        "backend": "sqlite",
        "profile": "default",
        "source": str(Path(database).expanduser()),
        "refreshedAt": utc_now(),
        "tables": tables,
    }


def quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def write_private_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.tmp-{os.getpid()}-{int(time.time() * 1000)}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(tmp_path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise


def load_or_refresh_schema(args: argparse.Namespace) -> dict[str, Any]:
    ensure_backend(args.backend)
    cache_dir = Path(args.cache_dir).expanduser() if args.cache_dir else default_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_path(cache_dir, args.backend, args.profile, args.database)
    ttl_seconds = max(0, int(args.cache_ttl_seconds))
    now = time.time()

    if path.exists() and not args.refresh:
        age_seconds = now - path.stat().st_mtime
        if ttl_seconds == 0 or age_seconds <= ttl_seconds:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if payload.get("cacheVersion") == CACHE_VERSION:
                payload["cache"] = {
                    "status": "hit",
                    "path": str(path),
                    "ageSeconds": int(age_seconds),
                    "ttlSeconds": ttl_seconds,
                }
                return payload

    if args.backend == "sqlite":
        payload = sqlite_schema(args.database)
        payload["profile"] = args.profile
    else:
        payload = normalize_backend_schema(args)
        payload["introspection"] = BACKEND_INTROSPECTION_SQL[args.backend]
        payload["adapter"] = "command" if resolve_backend_command(args) else "python-driver"

    write_private_json(path, payload)
    payload["cache"] = {
        "status": "refresh" if args.refresh else "miss",
        "path": str(path),
        "ageSeconds": 0,
        "ttlSeconds": ttl_seconds,
    }
    return payload


def strip_sql_comments(sql: str) -> str:
    without_block = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in without_block.splitlines())


def split_sql_statements(sql: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    quote: str | None = None
    index = 0
    while index < len(sql):
        char = sql[index]
        current.append(char)
        if quote:
            if char == quote:
                if index + 1 < len(sql) and sql[index + 1] == quote:
                    current.append(sql[index + 1])
                    index += 1
                else:
                    quote = None
        elif char in {"'", '"'}:
            quote = char
        elif char == ";":
            statement = "".join(current).strip().rstrip(";").strip()
            if statement:
                statements.append(statement)
            current = []
        index += 1
    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements


def first_keyword(statement: str) -> str:
    match = re.search(r"[A-Za-z_][A-Za-z0-9_]*", statement)
    return match.group(0).lower() if match else ""


def write_grant_matches(write_grant: str | None, expected_grant: str) -> bool:
    if not write_grant or not expected_grant:
        return False
    return hmac.compare_digest(write_grant, expected_grant)


def review_sql(
    sql: str,
    *,
    allow_write: bool = False,
    write_grant: str | None = None,
) -> ReviewResult:
    cleaned = strip_sql_comments(sql)
    statements = split_sql_statements(cleaned)
    findings: list[str] = []

    if not statements:
        findings.append("SQL is empty after removing comments.")

    if len(statements) > 1:
        findings.append("SQL must contain exactly one statement.")

    lowered = f" {cleaned.lower()} "
    keyword_hits = sorted(
        keyword
        for keyword in MUTATING_KEYWORDS
        if re.search(rf"\b{re.escape(keyword)}\b", lowered)
    )
    starter = first_keyword(statements[0]) if statements else ""
    read_only = bool(statements) and starter in READ_ONLY_STARTERS and not keyword_hits
    requires_write_grant = not read_only

    if keyword_hits:
        findings.append(f"Mutating or privileged keyword(s) found: {', '.join(keyword_hits)}.")
    if statements and starter not in READ_ONLY_STARTERS:
        findings.append(f"Statement starts with '{starter or 'unknown'}', not a read-only SQL verb.")
    if read_only and " limit " not in lowered and starter != "explain":
        findings.append("Exploratory read does not include LIMIT; add one unless an aggregate query requires all rows.")

    if requires_write_grant:
        expected_grant = os.environ.get(WRITE_GRANT_ENV, "")
        if not allow_write:
            findings.append("Write SQL requires --allow-write.")
        if not expected_grant:
            findings.append(f"Write SQL requires {WRITE_GRANT_ENV} to be set.")
        if not write_grant:
            findings.append("Write SQL requires --write-grant.")
        elif expected_grant and not write_grant_matches(write_grant, expected_grant):
            findings.append("Provided write grant does not match the per-skill grant.")

    write_approved = (
        requires_write_grant
        and allow_write
        and write_grant_matches(write_grant, os.environ.get(WRITE_GRANT_ENV, ""))
    )
    single_statement = len(statements) == 1
    status = "pass" if (read_only or write_approved) and single_statement else "block"
    return ReviewResult(
        status=status,
        read_only=read_only,
        statements=statements,
        findings=findings,
        requires_write_grant=requires_write_grant,
    )


def review_payload_from_result(sql: str, result: ReviewResult) -> dict[str, Any]:
    return {
        "sql": sql.strip(),
        "review": {
            "status": result.status,
            "readOnly": result.read_only,
            "statementCount": len(result.statements),
            "requiresWriteGrant": result.requires_write_grant,
            "findings": result.findings,
            "modelReview": {
                "required": True,
                "instructions": [
                    "Check that the SQL answers the user's business question.",
                    "Confirm joins and filters against the schema cache.",
                    "Return SQL before execution when the user asked to review it or scope is broad.",
                ],
            },
        },
    }


def review_payload(sql: str, args: argparse.Namespace) -> dict[str, Any]:
    result = review_sql(
        sql,
        allow_write=getattr(args, "allow_write", False),
        write_grant=getattr(args, "write_grant", None),
    )
    return review_payload_from_result(sql, result)


def execute_sqlite_query(
    database: str,
    sql: str,
    *,
    max_rows: int,
    parameters: list[Any] | None = None,
    allow_write: bool = False,
    write_grant: str | None = None,
    review_result: ReviewResult | None = None,
) -> dict[str, Any]:
    result = review_result or review_sql(
        sql,
        allow_write=allow_write,
        write_grant=write_grant,
    )
    if result.status != "pass":
        raise WarehouseSqlError("SQL review blocked execution: " + "; ".join(result.findings))
    with connect_sqlite(database) as conn:
        cursor = conn.execute(sql, parameters or [])
        if not result.read_only:
            conn.commit()
            return {
                "columns": [],
                "rows": [],
                "rowCount": 0,
                "affectedRows": cursor.rowcount,
                "truncated": False,
                "maxRows": max_rows,
            }
        rows = cursor.fetchmany(max_rows + 1)
        columns = list(rows[0].keys()) if rows else []
        truncated = len(rows) > max_rows
        rows = rows[:max_rows]
        return {
            "columns": columns,
            "rows": [dict(row) for row in rows],
            "rowCount": len(rows),
            "truncated": truncated,
            "maxRows": max_rows,
        }


def execute_backend_query(args: argparse.Namespace, sql: str) -> dict[str, Any]:
    rows = run_backend_sql(args, sql)
    max_rows = max(1, int(args.max_rows))
    truncated = len(rows) > max_rows
    rows = rows[:max_rows]
    columns = list(rows[0].keys()) if rows else []
    return {
        "columns": columns,
        "rows": rows,
        "rowCount": len(rows),
        "truncated": truncated,
        "maxRows": max_rows,
    }


def create_eval_database() -> str:
    handle = tempfile.NamedTemporaryFile(prefix="warehouse-sql-tpch-", suffix=".db", delete=False)
    handle.close()
    fixture = TPC_H_FIXTURE_PATH.read_text(encoding="utf-8")
    with sqlite3.connect(handle.name) as conn:
        conn.executescript(fixture)
    return handle.name


def load_scenarios() -> list[dict[str, Any]]:
    return json.loads(EVAL_SCENARIOS_PATH.read_text(encoding="utf-8"))


def plan_eval_sql(question: str) -> dict[str, Any]:
    sys.path.insert(0, str(SKILL_DIR / "evals"))
    try:
        from tpch_eval_planner import plan_eval_sql as eval_planner  # type: ignore

        return eval_planner(question)
    finally:
        try:
            sys.path.remove(str(SKILL_DIR / "evals"))
        except ValueError:
            pass


def first_cell(rows: list[dict[str, Any]]) -> Any:
    if not rows:
        return None
    first_row = rows[0]
    if not first_row:
        return None
    return next(iter(first_row.values()))


def run_eval_scenarios() -> dict[str, Any]:
    database = create_eval_database()
    scenarios = load_scenarios()
    results = []
    category_counts: dict[str, int] = {}
    failed = 0
    try:
        for scenario in scenarios:
            category = str(scenario.get("category", "uncategorized"))
            category_counts[category] = category_counts.get(category, 0) + 1
            case_result: dict[str, Any] = {
                "id": scenario["id"],
                "category": category,
                "status": "pass",
                "findings": [],
            }
            try:
                plan = plan_eval_sql(str(scenario["question"]))
                sql = plan["sql"]
                for expected in scenario.get("expectedSqlContains", []):
                    if str(expected).lower() not in sql.lower():
                        case_result["findings"].append(f"SQL missing expected token: {expected}")
                query_result = execute_sqlite_query(
                    database,
                    sql,
                    max_rows=DEFAULT_MAX_ROWS,
                    parameters=plan.get("parameters", []),
                )
                if "expectedRowCount" in scenario and query_result["rowCount"] != scenario["expectedRowCount"]:
                    case_result["findings"].append(
                        f"row count {query_result['rowCount']} != {scenario['expectedRowCount']}"
                    )
                if "expectedFirstValue" in scenario:
                    actual = first_cell(query_result["rows"])
                    expected = scenario["expectedFirstValue"]
                    if actual != expected:
                        case_result["findings"].append(f"first value {actual!r} != {expected!r}")
                if case_result["findings"]:
                    case_result["status"] = "fail"
                    failed += 1
            except Exception as exc:  # noqa: BLE001 - surface per-scenario failure
                case_result["status"] = "fail"
                case_result["findings"].append(str(exc))
                failed += 1
            results.append(case_result)
    finally:
        try:
            Path(database).unlink()
        except OSError:
            pass

    return {
        "command": "eval-scenarios",
        "dataset": "TPC-H-style tiny fixture",
        "scenarioCount": len(scenarios),
        "failed": failed,
        "categories": category_counts,
        "results": results,
    }


def handle_schema(args: argparse.Namespace) -> Any:
    return load_or_refresh_schema(args)


def handle_backend_contract(args: argparse.Namespace) -> Any:
    ensure_backend(args.backend)
    if args.backend == "sqlite":
        return {
            "backend": "sqlite",
            "execution": "python-stdlib sqlite3",
            "introspection": {
                "tables": "sqlite_master WHERE type IN ('table', 'view')",
                "columns": "PRAGMA table_info(<table>)",
                "foreignKeys": "PRAGMA foreign_key_list(<table>)",
            },
        }
    return {
        "backend": args.backend,
        "execution": "operator-approved connector required",
        "introspection": BACKEND_INTROSPECTION_SQL[args.backend],
    }


def resolve_gateway_url(args: argparse.Namespace) -> str:
    return (
        str(getattr(args, "gateway_url", "") or "").strip()
        or os.environ.get("HYBRIDCLAW_GATEWAY_URL", "").strip()
        or os.environ.get("GATEWAY_BASE_URL", "").strip()
        or DEFAULT_GATEWAY_URL
    )


def resolve_gateway_token(args: argparse.Namespace) -> str:
    return (
        str(getattr(args, "gateway_token", "") or "").strip()
        or os.environ.get("HYBRIDCLAW_GATEWAY_TOKEN", "").strip()
        or os.environ.get("GATEWAY_API_TOKEN", "").strip()
        or ""
    )


def build_refresh_command(args: argparse.Namespace) -> list[str]:
    command = [
        "python3",
        "skills/warehouse-sql/scripts/warehouse_sql.py",
        "--format",
        "json",
        "schema",
        "--backend",
        args.backend,
        "--profile",
        args.profile,
        "--refresh",
    ]
    if args.database:
        command.extend(["--database", args.database])
    if getattr(args, "cache_dir", None):
        command.extend(["--cache-dir", args.cache_dir])
    if getattr(args, "backend_command", None):
        command.extend(["--backend-command", args.backend_command])
    return command


def scheduler_job_payload(args: argparse.Namespace) -> dict[str, Any]:
    ensure_backend(args.backend)
    job_id = (
        str(getattr(args, "job_id", "") or "").strip()
        or f"warehouse-sql-schema-{args.backend}-{args.profile}".replace("_", "-")
    )
    command = build_refresh_command(args)
    message = "Refresh the warehouse SQL schema cache by running this exact command and report success or failure:\n\n```bash\n" + " ".join(shlex.quote(part) for part in command) + "\n```"
    return {
        "id": job_id,
        "name": f"Warehouse SQL schema refresh ({args.backend}/{args.profile})",
        "description": "Refresh cached warehouse schema introspection for the warehouse-sql skill.",
        "enabled": True,
        "agentId": args.agent_id,
        "boardStatus": "backlog",
        "schedule": {
            "kind": "cron",
            "expr": args.every,
            "tz": args.time_zone,
        },
        "action": {
            "kind": "agent_turn",
            "message": message,
        },
        "delivery": {
            "kind": "channel",
            "to": args.delivery_channel,
        },
    }


def handle_schedule_refresh(args: argparse.Namespace) -> Any:
    job = scheduler_job_payload(args)
    if args.dry_run:
        return {"status": "dry-run", "job": job}

    gateway_url = resolve_gateway_url(args).rstrip("/")
    token = resolve_gateway_token(args)
    payload = json.dumps({"job": job}).encode("utf-8")
    req = request.Request(
        f"{gateway_url}/api/admin/scheduler",
        data=payload,
        method="PUT",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with request.urlopen(req, timeout=max(1, int(args.timeout_seconds))) as response:
            raw = response.read().decode("utf-8")
            body = json.loads(raw) if raw.strip() else {}
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise WarehouseSqlError(f"Gateway scheduler registration failed ({exc.code}): {detail}") from exc
    except error.URLError as exc:
        raise WarehouseSqlError(f"Gateway scheduler registration failed: {exc.reason}") from exc
    return {
        "status": "registered",
        "gatewayUrl": gateway_url,
        "jobId": job["id"],
        "job": job,
        "scheduler": body,
    }


def handle_query(args: argparse.Namespace) -> Any:
    ensure_backend(args.backend)
    review_result = review_sql(
        args.sql,
        allow_write=args.allow_write,
        write_grant=args.write_grant,
    )
    payload = review_payload_from_result(args.sql, review_result)
    if not args.execute:
        payload["execution"] = {
            "status": "not-run",
            "reason": "query defaults to review-only; pass --execute after review",
        }
        return payload
    if payload["review"]["status"] != "pass":
        payload["execution"] = {
            "status": "blocked",
            "reason": "; ".join(payload["review"]["findings"]),
        }
        return payload
    if args.backend == "sqlite":
        parameters = json.loads(args.params) if args.params else []
        if not isinstance(parameters, list):
            raise WarehouseSqlError("--params must be a JSON array.")
        result = execute_sqlite_query(
            args.database,
            args.sql,
            max_rows=args.max_rows,
            parameters=parameters,
            review_result=review_result,
        )
        adapter = "python-stdlib sqlite3"
    else:
        result = execute_backend_query(args, args.sql)
        adapter = "command" if resolve_backend_command(args) else "python-driver"
    payload["execution"] = {
        "status": "ran",
        "backend": args.backend,
        "adapter": adapter,
        **result,
    }
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Warehouse SQL schema cache, safety review, execution, scheduler, and eval helper."
    )
    parser.add_argument("--format", choices=["text", "json"], default="text")
    subparsers = parser.add_subparsers(dest="command", required=True)

    schema = subparsers.add_parser("schema", help="Read or refresh cached schema introspection.")
    schema.add_argument("--backend", choices=sorted(BACKENDS), required=True)
    schema.add_argument("--database", help="SQLite database path for sqlite backend.")
    schema.add_argument("--profile", default="default", help="Logical warehouse profile name.")
    schema.add_argument("--cache-dir", help="Schema cache directory.")
    schema.add_argument("--cache-ttl-seconds", type=int, default=DEFAULT_CACHE_TTL_SECONDS)
    schema.add_argument("--backend-command", help="Executable connector command that reads SQL on stdin and emits JSON/CSV rows.")
    schema.add_argument("--timeout-seconds", type=int, default=60)
    schema.add_argument("--refresh", action="store_true", help="Force a schema refresh.")
    schema.set_defaults(func=handle_schema)

    contract = subparsers.add_parser("backend-contract", help="Emit backend introspection contract.")
    contract.add_argument("--backend", choices=sorted(BACKENDS), required=True)
    contract.set_defaults(func=handle_backend_contract)

    schedule_refresh = subparsers.add_parser("schedule-refresh", help="Register a gateway scheduler job that refreshes schema cache.")
    schedule_refresh.add_argument("--backend", choices=sorted(BACKENDS), required=True)
    schedule_refresh.add_argument("--database", help="SQLite database path for sqlite backend.")
    schedule_refresh.add_argument("--profile", default="default")
    schedule_refresh.add_argument("--cache-dir", help="Schema cache directory.")
    schedule_refresh.add_argument("--backend-command", help="Executable connector command that reads SQL on stdin and emits JSON/CSV rows.")
    schedule_refresh.add_argument("--every", default="0 */6 * * *", help="Cron expression.")
    schedule_refresh.add_argument("--time-zone", default="UTC")
    schedule_refresh.add_argument("--job-id")
    schedule_refresh.add_argument("--agent-id", default="main")
    schedule_refresh.add_argument("--delivery-channel", default="scheduler")
    schedule_refresh.add_argument("--gateway-url")
    schedule_refresh.add_argument("--gateway-token")
    schedule_refresh.add_argument("--timeout-seconds", type=int, default=30)
    schedule_refresh.add_argument("--dry-run", action="store_true")
    schedule_refresh.set_defaults(func=handle_schedule_refresh)

    review = subparsers.add_parser("review", help="Review SQL safety without execution.")
    review.add_argument("sql")
    review.add_argument("--allow-write", action="store_true")
    review.add_argument("--write-grant")
    review.set_defaults(func=lambda args: review_payload(args.sql, args))

    query = subparsers.add_parser("query", help="Review SQL and optionally execute it.")
    query.add_argument("--backend", choices=sorted(BACKENDS), required=True)
    query.add_argument("--database", help="SQLite database path for sqlite backend.")
    query.add_argument("--execute", action="store_true")
    query.add_argument("--max-rows", type=int, default=DEFAULT_MAX_ROWS)
    query.add_argument("--profile", default="default")
    query.add_argument("--backend-command", help="Executable connector command that reads SQL on stdin and emits JSON/CSV rows.")
    query.add_argument("--timeout-seconds", type=int, default=60)
    query.add_argument("--params", help="JSON array of SQLite parameters for positional placeholders.")
    query.add_argument("--allow-write", action="store_true")
    query.add_argument("--write-grant")
    query.add_argument("sql")
    query.set_defaults(func=handle_query)

    evals = subparsers.add_parser("eval-scenarios", help="Run bundled TPC-H-style eval scenarios.")
    evals.set_defaults(func=lambda _args: run_eval_scenarios())

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = args.func(args)
        emit(payload, args.format)
        return 0
    except WarehouseSqlError as exc:
        emit({"error": str(exc)}, args.format)
        return 2


if __name__ == "__main__":
    sys.exit(main())
