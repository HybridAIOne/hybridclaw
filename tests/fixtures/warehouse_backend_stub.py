#!/usr/bin/env python3
# ruff: noqa: INP001
from __future__ import annotations

import json
import os
import sys

WRITE_GRANT_ENV = "HYBRIDCLAW_WAREHOUSE_SQL_WRITE_GRANT"

sql = sys.stdin.read().lower()

if "env_check" in sql:
    rows = [
        {
            "has_write_grant": WRITE_GRANT_ENV in os.environ,
            "backend": os.environ.get("WAREHOUSE_SQL_BACKEND"),
            "profile": os.environ.get("WAREHOUSE_SQL_PROFILE"),
        }
    ]
elif "bad_rows" in sql:
    rows = [["not", "an", "object"]]
elif "information_schema.tables" in sql:
    rows = [
        {
            "table_schema": "public",
            "table_name": "customer",
            "table_type": "BASE TABLE",
        },
        {
            "table_schema": "public",
            "table_name": "orders",
            "table_type": "BASE TABLE",
        },
    ]
elif "information_schema.columns" in sql:
    rows = [
        {
            "table_schema": "public",
            "table_name": "customer",
            "column_name": "c_custkey",
            "data_type": "integer",
            "is_nullable": "NO",
            "ordinal_position": 1,
        },
        {
            "table_schema": "public",
            "table_name": "customer",
            "column_name": "c_name",
            "data_type": "text",
            "is_nullable": "NO",
            "ordinal_position": 2,
        },
        {
            "table_schema": "public",
            "table_name": "orders",
            "column_name": "o_orderkey",
            "data_type": "integer",
            "is_nullable": "NO",
            "ordinal_position": 1,
        },
        {
            "table_schema": "public",
            "table_name": "orders",
            "column_name": "o_custkey",
            "data_type": "integer",
            "is_nullable": "NO",
            "ordinal_position": 2,
        },
    ]
elif "constraint_type = 'foreign key'" in sql:
    rows = [
        {
            "table_schema": "public",
            "table_name": "orders",
            "column_name": "o_custkey",
            "references_schema": "public",
            "references_table": "customer",
            "references_column": "c_custkey",
        }
    ]
else:
    rows = [{"c_name": "Customer#000000101", "revenue": 1650.0}]

print(json.dumps(rows))
