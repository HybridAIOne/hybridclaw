import type Database from 'better-sqlite3';

export function queryOne<Row, Bind extends unknown[] = []>(
  database: Database.Database,
  sql: string,
  ...params: Bind
): Row | undefined;
export function queryOne<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row | undefined;
export function queryOne<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row | undefined {
  return database.prepare<unknown[], Row>(sql).get(...params);
}

export function queryAll<Row, Bind extends unknown[] = []>(
  database: Database.Database,
  sql: string,
  ...params: Bind
): Row[];
export function queryAll<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row[];
export function queryAll<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row[] {
  return database.prepare<unknown[], Row>(sql).all(...params);
}
