PRAGMA foreign_keys = ON;

CREATE TABLE nation (
  n_nationkey INTEGER PRIMARY KEY,
  n_name TEXT NOT NULL,
  n_region TEXT NOT NULL
);

CREATE TABLE customer (
  c_custkey INTEGER PRIMARY KEY,
  c_name TEXT NOT NULL,
  c_nationkey INTEGER NOT NULL REFERENCES nation(n_nationkey),
  c_mktsegment TEXT NOT NULL
);

CREATE TABLE supplier (
  s_suppkey INTEGER PRIMARY KEY,
  s_name TEXT NOT NULL,
  s_nationkey INTEGER NOT NULL REFERENCES nation(n_nationkey)
);

CREATE TABLE part (
  p_partkey INTEGER PRIMARY KEY,
  p_name TEXT NOT NULL,
  p_brand TEXT NOT NULL,
  p_type TEXT NOT NULL
);

CREATE TABLE orders (
  o_orderkey INTEGER PRIMARY KEY,
  o_custkey INTEGER NOT NULL REFERENCES customer(c_custkey),
  o_orderstatus TEXT NOT NULL,
  o_totalprice REAL NOT NULL,
  o_orderdate TEXT NOT NULL
);

CREATE TABLE lineitem (
  l_orderkey INTEGER NOT NULL REFERENCES orders(o_orderkey),
  l_partkey INTEGER NOT NULL REFERENCES part(p_partkey),
  l_suppkey INTEGER NOT NULL REFERENCES supplier(s_suppkey),
  l_quantity REAL NOT NULL,
  l_extendedprice REAL NOT NULL,
  l_discount REAL NOT NULL,
  l_shipdate TEXT NOT NULL,
  l_commitdate TEXT NOT NULL,
  l_receiptdate TEXT NOT NULL
);

INSERT INTO nation VALUES
  (1, 'GERMANY', 'EUROPE'),
  (2, 'FRANCE', 'EUROPE'),
  (3, 'UNITED STATES', 'AMERICA');

INSERT INTO customer VALUES
  (101, 'Customer#000000101', 1, 'AUTOMOBILE'),
  (102, 'Customer#000000102', 2, 'BUILDING'),
  (103, 'Customer#000000103', 3, 'MACHINERY');

INSERT INTO supplier VALUES
  (201, 'Supplier#000000201', 1),
  (202, 'Supplier#000000202', 2),
  (203, 'Supplier#000000203', 3);

INSERT INTO part VALUES
  (301, 'green widget', 'Brand#11', 'ECONOMY ANODIZED STEEL'),
  (302, 'blue bolt', 'Brand#22', 'STANDARD POLISHED COPPER'),
  (303, 'red gear', 'Brand#11', 'PROMO BRUSHED TIN');

INSERT INTO orders VALUES
  (401, 101, 'O', 1200.00, '1995-03-10'),
  (402, 102, 'F', 900.00, '1995-03-12'),
  (403, 101, 'F', 700.00, '1995-04-01'),
  (404, 103, 'O', 400.00, '1995-04-20');

INSERT INTO lineitem VALUES
  (401, 301, 201, 5, 1000.00, 0.05, '1995-03-14', '1995-03-13', '1995-03-16'),
  (401, 302, 202, 2, 300.00, 0.00, '1995-03-15', '1995-03-17', '1995-03-16'),
  (402, 302, 202, 4, 900.00, 0.10, '1995-03-20', '1995-03-19', '1995-03-22'),
  (403, 303, 201, 1, 700.00, 0.00, '1995-04-05', '1995-04-07', '1995-04-06'),
  (404, 301, 203, 2, 400.00, 0.05, '1995-04-25', '1995-04-24', '1995-04-26');
