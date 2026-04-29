from __future__ import annotations

import re
from typing import Any

DEFAULT_MAX_ROWS = 200


def normalize_question(question: str) -> str:
    return re.sub(r"\s+", " ", question.strip().lower())


def extract_customer_name(question: str) -> str | None:
    match = re.search(r"customer#\d+", question, flags=re.I)
    return match.group(0) if match else None


def plan_eval_sql(question: str, *, limit: int = 10) -> dict[str, Any]:
    q = normalize_question(question)
    customer = extract_customer_name(question)
    capped_limit = max(1, min(limit, DEFAULT_MAX_ROWS))
    parameters: list[Any] = []

    if "top customer" in q and "revenue" in q:
        sql = f"""
SELECT c.c_name, ROUND(SUM(l.l_extendedprice * (1 - l.l_discount)), 2) AS revenue
FROM customer c
JOIN orders o ON o.o_custkey = c.c_custkey
JOIN lineitem l ON l.l_orderkey = o.o_orderkey
GROUP BY c.c_name
ORDER BY revenue DESC
LIMIT {capped_limit}
""".strip()
    elif "revenue by nation" in q:
        sql = f"""
SELECT n.n_name, ROUND(SUM(l.l_extendedprice * (1 - l.l_discount)), 2) AS revenue
FROM nation n
JOIN customer c ON c.c_nationkey = n.n_nationkey
JOIN orders o ON o.o_custkey = c.c_custkey
JOIN lineitem l ON l.l_orderkey = o.o_orderkey
GROUP BY n.n_name
ORDER BY revenue DESC
LIMIT {capped_limit}
""".strip()
    elif "late shipment" in q:
        sql = f"""
SELECT l_orderkey, l_partkey, l_suppkey, l_commitdate, l_receiptdate
FROM lineitem
WHERE l_receiptdate > l_commitdate
ORDER BY l_receiptdate
LIMIT {capped_limit}
""".strip()
    elif "open order" in q and "status" in q:
        sql = """
SELECT o_orderstatus, COUNT(*) AS order_count
FROM orders
WHERE o_orderstatus = 'O'
GROUP BY o_orderstatus
ORDER BY order_count DESC, o_orderstatus
LIMIT 10
""".strip()
    elif customer and "order" in q:
        parameters = [customer]
        sql = f"""
SELECT o.o_orderkey, o.o_orderdate, o.o_orderstatus, o.o_totalprice
FROM orders o
JOIN customer c ON c.c_custkey = o.o_custkey
WHERE c.c_name = ?
ORDER BY o.o_orderdate
LIMIT {capped_limit}
""".strip()
    elif "discount" in q and "brand" in q:
        sql = """
SELECT p.p_brand, ROUND(AVG(l.l_discount), 4) AS avg_discount
FROM part p
JOIN lineitem l ON l.l_partkey = p.p_partkey
GROUP BY p.p_brand
ORDER BY p.p_brand
LIMIT 10
""".strip()
    elif "supplier" in q and "revenue" in q:
        sql = f"""
SELECT s.s_name, ROUND(SUM(l.l_extendedprice * (1 - l.l_discount)), 2) AS revenue
FROM supplier s
JOIN lineitem l ON l.l_suppkey = s.s_suppkey
GROUP BY s.s_name
ORDER BY revenue DESC
LIMIT {capped_limit}
""".strip()
    elif "customer count" in q and ("segment" in q or "market" in q):
        sql = """
SELECT c_mktsegment, COUNT(*) AS customer_count
FROM customer
GROUP BY c_mktsegment
ORDER BY customer_count DESC, c_mktsegment
LIMIT 10
""".strip()
    elif "part" in q and "brand" in q:
        sql = """
SELECT p_brand, COUNT(*) AS part_count
FROM part
GROUP BY p_brand
ORDER BY part_count DESC, p_brand
LIMIT 10
""".strip()
    elif "daily" in q and "order" in q:
        sql = """
SELECT o_orderdate, ROUND(SUM(o_totalprice), 2) AS order_total
FROM orders
GROUP BY o_orderdate
ORDER BY o_orderdate
LIMIT 50
""".strip()
    elif "revenue" in q and "march" in q and "1995" in q:
        sql = """
SELECT ROUND(SUM(l.l_extendedprice * (1 - l.l_discount)), 2) AS revenue
FROM orders o
JOIN lineitem l ON l.l_orderkey = o.o_orderkey
WHERE o.o_orderdate >= '1995-03-01'
  AND o.o_orderdate < '1995-04-01'
""".strip()
    elif "largest order" in q:
        sql = f"""
SELECT o_orderkey, o_orderdate, o_totalprice
FROM orders
ORDER BY o_totalprice DESC
LIMIT {capped_limit}
""".strip()
    else:
        raise ValueError(f"No TPC-H eval SQL matched question: {question}")

    return {"sql": sql, "parameters": parameters}
