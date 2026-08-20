import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DB_PATH } from '../config/config.js';
import type { RuntimeSchedulerJob } from '../config/runtime-config.js';
import { runtimeConfigRevisionStorePath } from '../config/runtime-config-revisions.js';
import { logger } from '../logger.js';
import { DEFAULT_RESOURCE_HYGIENE_SCHEDULER_JOB } from '../scheduler/system-jobs.js';
import type { ScheduledTask } from '../types/scheduler.js';
import {
  type InitDatabaseOptions,
  runMigrations,
  tableExists,
} from './schema/migrations.js';
import { queryAll, queryOne } from './sqlite.js';

let db: Database.Database;
let databaseInitialized = false;

export function initDatabase(opts?: InitDatabaseOptions): void {
  const quiet = opts?.quiet === true;
  const dbPath = path.resolve(opts?.dbPath || DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = openDatabaseWithWalRecovery(dbPath);
  runMigrations(db, opts);
  migrateLegacyTasksToJobsTable();
  ensureDefaultSchedulerJobs();
  databaseInitialized = true;
  if (!quiet) logger.info({ path: dbPath }, 'Database initialized');
}

/**
 * Checkpoint and close the database. Call this on shutdown after every
 * subsystem that writes to the database has stopped: a clean checkpoint +
 * close flushes the WAL into the main file and removes it, so a later kill
 * of the process cannot leave a WAL on disk that no longer matches the
 * database file.
 */
export function closeDatabase(): void {
  if (!databaseInitialized) return;
  databaseInitialized = false;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    logger.warn({ error }, 'WAL checkpoint during database close failed');
  }
  try {
    db.close();
  } catch (error) {
    logger.warn({ error }, 'Database close failed');
  }
}

function isCorruptionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (
    typeof code === 'string' &&
    (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
  ) {
    return true;
  }
  return error.message.includes('database disk image is malformed');
}

type CheckedOpen =
  | { ok: true; database: Database.Database }
  | { ok: false; database: Database.Database | null };

/**
 * Open dbPath and report whether `PRAGMA integrity_check` passes. On
 * corruption the (still open) connection is returned so the caller can
 * dispose of it safely; non-corruption errors are rethrown.
 *
 * This uses the full integrity_check rather than quick_check: quick_check
 * skips verifying that index content matches table content, so an index
 * that has silently diverged from its table (missing or stale entries,
 * which makes index-scan queries return wrong results) passes quick_check
 * silently. integrity_check catches it — and now that startup can heal that
 * class of damage with REINDEX (see openDatabaseWithWalRecovery), detecting
 * it here is strictly better than staying blind to it.
 */
function openCheckedConnection(dbPath: string): CheckedOpen {
  let database: Database.Database | undefined;
  try {
    database = new Database(dbPath);
    database.pragma('journal_mode = WAL');
    // SQLite foreign-key enforcement is connection-scoped, so enable it before
    // running migrations or accepting writes on this writable connection.
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    const rows = database.pragma('integrity_check(1)') as Array<
      Record<string, unknown>
    >;
    if (rows.length === 1 && Object.values(rows[0] ?? {})[0] === 'ok') {
      return { ok: true, database };
    }
  } catch (error) {
    if (!isCorruptionError(error)) {
      try {
        database?.close();
      } catch {
        // The original error is the one worth surfacing.
      }
      throw error;
    }
  }
  return { ok: false, database: database ?? null };
}

const ROWID_WALK_BATCH = 256;
const MAX_CONSECUTIVE_ROW_SKIPS = 10_000;

interface RebuildSummary {
  droppedRows: number;
  droppedByTable: Record<string, number>;
  skippedSchemaObjects: string[];
}

interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `sql` mentions any of `skippedTables` as a bare identifier. */
function referencesSkippedTable(
  sql: string,
  skippedTables: Set<string>,
): boolean {
  for (const table of skippedTables) {
    if (new RegExp(`\\b${escapeRegExp(table)}\\b`).test(sql)) return true;
  }
  return false;
}

/**
 * Copy every row of `table` from the ATTACHed `src` database into `dest`.
 * Tries a single bulk statement first; if that throws (a corrupt page
 * anywhere in the table poisons the whole statement), starts over with a
 * walk over SOURCE rowids: fetch the next batch of readable rowids, copy
 * them one row at a time, and when even a single-rowid fetch throws, step
 * the cursor forward by one until the b-tree seek escapes the corrupt leaf
 * page's key range and lands on the next healthy page. The cursor tracks
 * source rowids only — the destination assigns fresh rowids for tables
 * without an INTEGER PRIMARY KEY alias, so destination state says nothing
 * about how far the source scan has progressed.
 *
 * Caveat: for a table lacking an INTEGER PRIMARY KEY alias the rowids
 * themselves are not preserved. Every real table in this schema carries an
 * explicit id column, and the one rowid-linked structure (the FTS index) is
 * skipped here and rebuilt from `messages` by the schema migrations.
 */
function copyTableData(
  dest: Database.Database,
  table: string,
  summary: RebuildSummary,
): void {
  const quoted = `"${table.replace(/"/g, '""')}"`;
  try {
    dest.exec(`INSERT INTO main.${quoted} SELECT * FROM src.${quoted}`);
    return;
  } catch (error) {
    logger.warn(
      { table, error },
      'Bulk copy of table failed during database salvage; falling back to a row-by-row scan',
    );
  }

  let dropped = 0;
  try {
    // Prepare before deleting anything: if the table can't be addressed by
    // rowid at all (prepare throws), the bulk copy's partial rows are all
    // we'll ever get and must survive.
    const fetchIdsStmt = dest.prepare(
      `SELECT rowid AS r FROM src.${quoted} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    );
    const insertRowStmt = dest.prepare(
      `INSERT INTO main.${quoted} SELECT * FROM src.${quoted} WHERE rowid = ?`,
    );

    // journal_mode=OFF gives no statement-level rollback guarantee, so the
    // failed bulk copy may have left a partial prefix behind. Start clean —
    // the walk below re-reads everything readable from the source.
    dest.exec(`DELETE FROM main.${quoted}`);

    let cursor = Number.MIN_SAFE_INTEGER;
    let batch = ROWID_WALK_BATCH;
    let consecutiveSkips = 0;

    for (;;) {
      let ids: number[];
      try {
        ids = (fetchIdsStmt.all(cursor, batch) as Array<{ r: number }>).map(
          (row) => row.r,
        );
      } catch {
        if (batch > 1) {
          batch = 1;
          continue;
        }
        // Even a single-rowid fetch just past `cursor` is unreadable — step
        // over it. Once `cursor` passes the corrupt leaf page's key range,
        // the seek lands on the next healthy page and the fetch recovers.
        cursor += 1;
        dropped += 1;
        consecutiveSkips += 1;
        if (consecutiveSkips >= MAX_CONSECUTIVE_ROW_SKIPS) {
          logger.warn(
            { table, cursor },
            'Too many consecutive unreadable rows during database salvage; abandoning the rest of this table',
          );
          break;
        }
        continue;
      }

      consecutiveSkips = 0;
      if (ids.length === 0) break; // end of table
      for (const id of ids) {
        try {
          insertRowStmt.run(id);
        } catch {
          dropped += 1;
        }
      }
      cursor = ids[ids.length - 1] as number;
      batch = ROWID_WALK_BATCH;
    }
  } catch (error) {
    // A table that can't be walked at all (e.g. WITHOUT ROWID — none exist
    // in this schema today) keeps whatever the bulk copy managed; losing
    // one table's tail must not abort the whole rebuild.
    logger.warn(
      { table, error },
      'Row-by-row salvage of table failed; keeping the partial copy',
    );
    summary.droppedByTable[table] = summary.droppedByTable[table] ?? 0;
  }

  if (dropped > 0) {
    summary.droppedByTable[table] =
      (summary.droppedByTable[table] ?? 0) + dropped;
    summary.droppedRows += dropped;
  }
}

/**
 * Rebuild dbPath from scratch: recreate every schema object it still knows
 * about and copy across whatever rows are still readable, dropping (and
 * counting) the rest. This is the lossy, last-resort repair for damage that
 * REINDEX cannot fix — corrupted table pages, not just index pages.
 *
 * Virtual tables (and their shadow tables) are skipped rather than copied:
 * the only virtual table in this schema is `recent_chat_message_search`, an
 * FTS5 index over `messages` that the schema-migration layer detects as
 * missing and recreates + backfills at startup, so skipping it here is
 * lossless — it comes back on its own right after this function returns.
 *
 * Returns null (with dbPath and any scratch files it created cleaned up by
 * the caller) if the source can't be read at all or the rebuilt copy still
 * fails its integrity check.
 */
function attemptRebuildRepair(
  dbPath: string,
  ts: number,
): { database: Database.Database; summary: RebuildSummary } | null {
  const rebuildPath = `${dbPath}.rebuild-${ts}`;
  fs.rmSync(rebuildPath, { force: true });

  let source: Database.Database | undefined;
  let dest: Database.Database | undefined;
  const summary: RebuildSummary = {
    droppedRows: 0,
    droppedByTable: {},
    skippedSchemaObjects: [],
  };

  try {
    try {
      source = new Database(dbPath, { readonly: true });
    } catch {
      // Header trashed (SQLITE_NOTADB) or similarly unreadable — there is
      // nothing left to salvage rows from.
      return null;
    }

    let schemaRows: SchemaObjectRow[];
    try {
      schemaRows = source
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL',
        )
        .all() as SchemaObjectRow[];
    } catch {
      return null;
    }

    // Virtual tables and their FTS5 shadow tables ("<name>_*") are skipped;
    // everything else whose tbl_name points at a skipped table (its indexes,
    // triggers, views) is skipped too.
    const skippedTables = new Set<string>();
    for (const row of schemaRows) {
      if (row.name.startsWith('sqlite_')) continue;
      if (row.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(row.sql)) {
        skippedTables.add(row.name);
      }
    }
    for (const row of schemaRows) {
      if (row.type !== 'table' || row.name.startsWith('sqlite_')) continue;
      for (const virtualTable of skippedTables) {
        if (row.name.startsWith(`${virtualTable}_`)) {
          skippedTables.add(row.name);
        }
      }
    }

    const objects = schemaRows.filter((row) => {
      if (row.name.startsWith('sqlite_')) return false;
      if (skippedTables.has(row.name) || skippedTables.has(row.tbl_name)) {
        summary.skippedSchemaObjects.push(row.name);
        return false;
      }
      // A trigger's tbl_name is the table it fires ON, not the tables its
      // body references — e.g. the FTS5 shadow triggers fire on `messages`
      // but INSERT/DELETE into the skipped virtual table inside their body.
      // Recreating such a trigger without its target leaves a schema object
      // that fails not just when it fires, but on any later DDL that has to
      // resolve every trigger/view in the schema (observed: ALTER TABLE
      // RENAME on an unrelated table failing with "no such table"). Skip
      // any trigger/view whose body mentions a skipped table by name.
      if (
        (row.type === 'trigger' || row.type === 'view') &&
        referencesSkippedTable(row.sql, skippedTables)
      ) {
        summary.skippedSchemaObjects.push(row.name);
        return false;
      }
      return true;
    });
    const tables = objects.filter((o) => o.type === 'table');
    const indexes = objects.filter((o) => o.type === 'index');
    const others = objects.filter(
      (o) => o.type === 'trigger' || o.type === 'view',
    );

    dest = new Database(rebuildPath);
    // This is a scratch file we verify before it ever becomes dbPath, so
    // durability during the copy doesn't matter — only speed does. Foreign
    // keys stay off so table creation/copy order doesn't have to satisfy
    // them.
    dest.pragma('journal_mode = OFF');
    dest.pragma('synchronous = OFF');
    dest.pragma('foreign_keys = OFF');

    const createdTables = new Set<string>();
    for (const table of tables) {
      try {
        dest.exec(table.sql);
        createdTables.add(table.name);
      } catch (error) {
        logger.warn(
          { table: table.name, error },
          'Failed to recreate table during database salvage; skipping it',
        );
      }
    }

    // Copy data before creating indexes/triggers/views: indexes populate
    // automatically as rows land, and triggers must not fire on the copy
    // itself, so they're created afterward.
    source.close();
    source = undefined;
    const escapedSrcPath = dbPath.replace(/'/g, "''");
    dest.exec(`ATTACH DATABASE '${escapedSrcPath}' AS src`);
    for (const table of tables) {
      if (!createdTables.has(table.name)) continue;
      copyTableData(dest, table.name, summary);
    }
    try {
      // Preserve AUTOINCREMENT counters even for tables whose highest rowid
      // was among the rows we couldn't copy.
      dest.exec(
        'DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM src.sqlite_sequence',
      );
    } catch {
      // Neither side has AUTOINCREMENT tables (no sqlite_sequence table) —
      // nothing to preserve.
    }
    dest.exec('DETACH DATABASE src');

    for (const index of indexes) {
      if (!createdTables.has(index.tbl_name)) continue;
      try {
        dest.exec(index.sql);
      } catch (error) {
        logger.warn(
          { index: index.name, error },
          'Failed to recreate index during database salvage; skipping it',
        );
      }
    }
    for (const other of others) {
      // A trigger's tbl_name is the table it fires on — skip triggers whose
      // table didn't make it. A view's tbl_name is the view's own name, so
      // the gate must not apply to views (ones referencing skipped tables
      // were already filtered out above).
      if (other.type === 'trigger' && !createdTables.has(other.tbl_name)) {
        continue;
      }
      try {
        dest.exec(other.sql);
      } catch (error) {
        logger.warn(
          { name: other.name, type: other.type, error },
          'Failed to recreate schema object during database salvage; skipping it',
        );
      }
    }

    const check = dest.pragma('integrity_check') as Array<
      Record<string, unknown>
    >;
    if (check.length !== 1 || Object.values(check[0] ?? {})[0] !== 'ok') {
      dest.close();
      dest = undefined;
      fs.rmSync(rebuildPath, { force: true });
      return null;
    }
    dest.close();
    dest = undefined;

    // Swap the rebuild in. Forensic copies of the original were already
    // taken by the caller, so it's safe to delete the corrupt originals.
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.renameSync(rebuildPath, dbPath);

    const reopened = openCheckedConnection(dbPath);
    if (!reopened.ok) {
      try {
        reopened.database?.close();
      } catch {
        // Ignore; we're already reporting failure.
      }
      return null;
    }
    return { database: reopened.database, summary };
  } catch (error) {
    logger.warn(
      { error, path: dbPath },
      'Database rebuild salvage failed unexpectedly',
    );
    return null;
  } finally {
    try {
      source?.close();
    } catch {
      // Ignore.
    }
    try {
      dest?.close();
    } catch {
      // Ignore.
    }
  }
}

/**
 * Attempt to REINDEX dbPath in place. REINDEX only rebuilds index content
 * from the table data it indexes, so it losslessly repairs an index that
 * has diverged from (or was structurally damaged relative to) its table —
 * the case openCheckedConnection's integrity_check now detects that
 * quick_check used to miss. On a structurally damaged index btree REINDEX
 * itself can throw SQLITE_CORRUPT; that's an expected outcome here, not a
 * bug, so it's swallowed and treated as "this repair didn't work."
 */
function attemptReindexRepair(dbPath: string): Database.Database | null {
  let database: Database.Database | undefined;
  try {
    database = new Database(dbPath);
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    try {
      database.exec('REINDEX');
    } catch {
      // Fall through to the checked re-open, which will fail and send us
      // to the rebuild path.
    }
    database.close();
    database = undefined;
  } catch {
    try {
      database?.close();
    } catch {
      // Ignore.
    }
    return null;
  }

  const reopened = openCheckedConnection(dbPath);
  if (reopened.ok) return reopened.database;
  try {
    reopened.database?.close();
  } catch {
    // Ignore.
  }
  return null;
}

/**
 * Attempt to recover a database whose main file itself fails its integrity
 * check (not merely a stale WAL — see openDatabaseWithWalRecovery). Takes a
 * forensic snapshot of the current on-disk state first — REINDEX mutates in
 * place, so the snapshot has to exist before any repair touches the file —
 * then tries, in order of how much data each preserves:
 *
 *  1. REINDEX: lossless. Fixes damaged/diverged indexes without touching
 *     table content.
 *  2. Rebuild: lossy. Recreates the schema in a new file and copies every
 *     row that's still readable, table by table, dropping and counting the
 *     rest. Handles damaged table pages that REINDEX can't touch.
 *
 * Returns the recovered connection, or null if neither repair worked, in
 * which case dbPath (and its -wal/-shm) is restored byte-for-byte from the
 * forensic snapshot — the repair attempts mutate the file in place (REINDEX,
 * and closing a connection checkpoints the WAL), and whoever repairs this by
 * hand must get the original state, not a half-repaired one. The snapshots
 * and any `.rebuild-*` scratch file are then removed.
 */
function salvageCorruptDatabase(dbPath: string): Database.Database | null {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const ts = Date.now();
  const dbSnapshot = `${dbPath}.corrupt-${ts}`;
  const walSnapshot = `${walPath}.corrupt-${ts}`;
  const shmSnapshot = `${shmPath}.corrupt-${ts}`;
  const forensicPaths: string[] = [];

  try {
    fs.copyFileSync(dbPath, dbSnapshot);
    forensicPaths.push(dbSnapshot);
  } catch (error) {
    logger.warn(
      { error, path: dbPath },
      'Failed to snapshot corrupt database before attempting salvage; giving up on salvage',
    );
    return null;
  }
  if (fs.existsSync(walPath)) {
    fs.copyFileSync(walPath, walSnapshot);
    forensicPaths.push(walSnapshot);
  }
  if (fs.existsSync(shmPath)) {
    fs.copyFileSync(shmPath, shmSnapshot);
    forensicPaths.push(shmSnapshot);
  }

  const reindexed = attemptReindexRepair(dbPath);
  if (reindexed) {
    logger.warn(
      { path: dbPath, forensic: forensicPaths },
      'Database self-healed by rebuilding its indexes; rows referenced by the damaged index were preserved',
    );
    return reindexed;
  }

  const rebuilt = attemptRebuildRepair(dbPath, ts);
  if (rebuilt) {
    logger.error(
      {
        path: dbPath,
        forensic: forensicPaths,
        droppedRows: rebuilt.summary.droppedRows,
        droppedByTable: rebuilt.summary.droppedByTable,
        skippedSchemaObjects: rebuilt.summary.skippedSchemaObjects,
      },
      'Database salvaged by rebuilding it from readable rows; some rows were lost',
    );
    return rebuilt.database;
  }

  // Both repairs failed. They mutated dbPath in place (REINDEX writes, and
  // closing a connection checkpoints the WAL), so put the original bytes
  // back from the snapshot before cleaning up — manual repair must start
  // from the state this function found, not from a half-repaired one. A
  // -wal/-shm that only appeared during the repair attempts is removed.
  try {
    fs.copyFileSync(dbSnapshot, dbPath);
    if (forensicPaths.includes(walSnapshot)) {
      fs.copyFileSync(walSnapshot, walPath);
    } else {
      fs.rmSync(walPath, { force: true });
    }
    if (forensicPaths.includes(shmSnapshot)) {
      fs.copyFileSync(shmSnapshot, shmPath);
    } else {
      fs.rmSync(shmPath, { force: true });
    }
  } catch (error) {
    logger.warn(
      { error, path: dbPath, forensic: forensicPaths },
      'Failed to restore the database from its forensic snapshot; keeping the snapshot files',
    );
    return null;
  }
  for (const forensicPath of forensicPaths) {
    fs.rmSync(forensicPath, { force: true });
  }
  fs.rmSync(`${dbPath}.rebuild-${ts}`, { force: true });
  return null;
}

/**
 * Open the database, verifying integrity first. If the combination of main
 * file + WAL is corrupt but the main file alone is intact, quarantine the
 * -wal/-shm files and continue from the last checkpoint.
 *
 * A WAL that no longer matches the database file is what a hard kill of the
 * runtime can leave behind (cached WAL writes lost while checkpointed main
 * file writes survived). Recovering that stale WAL makes every read fail
 * with SQLITE_CORRUPT even though the main file is fine — and because the
 * WAL sits next to the database, the failure survives restarts until the
 * WAL is removed. Losing the WAL's tail is strictly better than an
 * unbootable gateway; the quarantined files are kept for inspection.
 *
 * If the main file itself fails its check — either because there was no WAL
 * to discard, or because discarding the WAL didn't fix it — this falls back
 * to salvageCorruptDatabase() before giving up: first REINDEX (lossless),
 * then a full rebuild from readable rows (lossy). Only if both of those
 * fail does this throw and leave the database for manual repair.
 */
function openDatabaseWithWalRecovery(dbPath: string): Database.Database {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const hadWalBeforeOpen = fs.existsSync(walPath);

  const first = openCheckedConnection(dbPath);
  if (first.ok) return first.database;

  if (!hadWalBeforeOpen) {
    try {
      first.database?.close();
    } catch {
      // Failing anyway.
    }
    const salvaged = salvageCorruptDatabase(dbPath);
    if (salvaged) return salvaged;
    throw new Error(
      `Database at ${dbPath} failed its integrity check and there is no WAL to discard; manual repair required`,
    );
  }

  // Preserve the WAL and shm for inspection, then empty the WAL BEFORE
  // closing the failed connection: closing the last connection makes SQLite
  // checkpoint the WAL into the main file, which would apply the very
  // corruption being discarded (observed to overwrite and truncate an intact
  // main file). Against an empty WAL that checkpoint cannot copy anything.
  const suffix = `.corrupt-${Date.now()}`;
  const walQuarantine = `${walPath}${suffix}`;
  const shmQuarantine = `${shmPath}${suffix}`;
  fs.copyFileSync(walPath, walQuarantine);
  const hadShm = fs.existsSync(shmPath);
  if (hadShm) fs.copyFileSync(shmPath, shmQuarantine);
  fs.truncateSync(walPath, 0);
  try {
    first.database?.close();
  } catch {
    // The connection already failed its check; carry on with recovery.
  }
  fs.rmSync(walPath, { force: true });
  fs.rmSync(shmPath, { force: true });
  logger.warn(
    { path: dbPath, quarantined: walQuarantine },
    'Database failed its integrity check; retrying without the WAL in case a stale WAL was left behind by a hard kill',
  );

  const second = openCheckedConnection(dbPath);
  if (second.ok) {
    logger.warn(
      { path: dbPath },
      'Database recovered by discarding a stale WAL; changes that only existed in the WAL are lost',
    );
    return second.database;
  }

  // The main file itself is damaged — put the WAL back so no state is lost
  // for whoever repairs this by hand.
  try {
    second.database?.close();
  } catch {
    // No WAL is present at this point, so closing cannot make things worse.
  }
  fs.copyFileSync(walQuarantine, walPath);
  fs.rmSync(walQuarantine, { force: true });
  if (hadShm) {
    fs.copyFileSync(shmQuarantine, shmPath);
    fs.rmSync(shmQuarantine, { force: true });
  }

  // Salvage against the restored state, not the WAL-discarded one: the WAL
  // may hold committed recent data, and reads through SQLite replay it.
  const salvaged = salvageCorruptDatabase(dbPath);
  if (salvaged) return salvaged;

  throw new Error(
    `Database at ${dbPath} failed its integrity check even without its WAL; manual repair required`,
  );
}

export function isDatabaseInitialized(): boolean {
  return databaseInitialized;
}

function ensureDatabaseReady(): void {
  if (databaseInitialized) return;
  initDatabase({ quiet: true });
}

export function withMemoryDatabase<T>(
  fn: (database: Database.Database) => T,
): T {
  ensureDatabaseReady();
  return fn(db);
}

export function withInitializedMemoryDatabase<T>(
  fn: (database: Database.Database) => T,
): T {
  if (!databaseInitialized) {
    throw new Error('Database is not initialized');
  }
  return fn(db);
}

export function withMemoryDatabaseRuntimeRevisionStore<T>(
  fn: (database: Database.Database, revisionSchemaName: string) => T,
): T {
  ensureDatabaseReady();
  return withRuntimeRevisionDatabaseAttached(() =>
    fn(db, RUNTIME_REVISION_ATTACHMENT),
  );
}

const RUNTIME_REVISION_ATTACHMENT = 'runtime_revisions';

function withRuntimeRevisionDatabaseAttached<T>(fn: () => T): T {
  const revisionDbPath = runtimeConfigRevisionStorePath();
  fs.mkdirSync(path.dirname(revisionDbPath), { recursive: true });
  db.prepare(`ATTACH DATABASE ? AS ${RUNTIME_REVISION_ATTACHMENT}`).run(
    revisionDbPath,
  );
  try {
    return fn();
  } finally {
    db.exec(`DETACH DATABASE ${RUNTIME_REVISION_ATTACHMENT}`);
  }
}

function schedulerJobToDbValues(job: RuntimeSchedulerJob): {
  name: string | null;
  description: string | null;
  agentId: string | null;
  boardStatus: string | null;
  maxRetries: number | null;
  schedule: string;
  action: string;
  delivery: string;
  enabled: number;
} {
  return {
    name: job.name?.trim() || null,
    description: job.description?.trim() || null,
    agentId: job.agentId?.trim() || null,
    boardStatus: job.boardStatus || null,
    maxRetries:
      typeof job.maxRetries === 'number' && Number.isFinite(job.maxRetries)
        ? Math.floor(job.maxRetries)
        : null,
    schedule: JSON.stringify(job.schedule),
    action: JSON.stringify(job.action),
    delivery: JSON.stringify(job.delivery),
    enabled: job.enabled ? 1 : 0,
  };
}

function nextSchedulerJobSortOrder(): number {
  const row = queryOne<{ next_order: number | null }>(
    db,
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM jobs WHERE kind = 'scheduler_job'",
  );
  return Math.max(0, Math.floor(row?.next_order ?? 0));
}

function schedulerJobExists(jobId: string): boolean {
  const row = queryOne<{ id: string }, [string]>(
    db,
    "SELECT id FROM jobs WHERE kind = 'scheduler_job' AND id = ?",
    jobId,
  );
  return Boolean(row);
}

function upsertDefaultSchedulerJob(job: RuntimeSchedulerJob): void {
  const jobId = job.id.trim();
  if (!jobId) return;
  const values = schedulerJobToDbValues({ ...job, id: jobId });
  db.prepare(
    `INSERT INTO jobs
      (id, kind, name, description, agent_id, board_status, max_retries, schedule, action, delivery, enabled, sort_order, created_at, updated_at)
     VALUES (?, 'scheduler_job', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    jobId,
    values.name,
    values.description,
    values.agentId,
    values.boardStatus,
    values.maxRetries,
    values.schedule,
    values.action,
    values.delivery,
    values.enabled,
    nextSchedulerJobSortOrder(),
  );
}

function ensureDefaultSchedulerJobs(): void {
  const defaults = [
    DEFAULT_RESOURCE_HYGIENE_SCHEDULER_JOB as RuntimeSchedulerJob,
  ];
  for (const job of defaults) {
    if (schedulerJobExists(job.id)) continue;
    upsertDefaultSchedulerJob(job);
  }
}

function migrateLegacyTasksToJobsTable(): void {
  if (!tableExists(db, 'tasks')) return;
  const legacyTasks = queryAll<ScheduledTask>(
    db,
    'SELECT * FROM tasks ORDER BY id ASC',
  );
  if (legacyTasks.length === 0) return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO jobs
      (id, kind, legacy_task_id, session_id, channel_id, schedule, action, delivery,
       enabled, last_run, last_status, consecutive_errors, sort_order, created_at, updated_at)
     VALUES (?, 'scheduled_task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  );
  const transaction = db.transaction((tasks: ScheduledTask[]) => {
    for (const task of tasks) {
      const schedule: RuntimeSchedulerJob['schedule'] = task.run_at
        ? { kind: 'at', at: task.run_at, everyMs: null, expr: null, tz: '' }
        : task.every_ms
          ? {
              kind: 'every',
              at: null,
              everyMs: task.every_ms,
              expr: null,
              tz: '',
            }
          : {
              kind: 'cron',
              at: null,
              everyMs: null,
              expr: task.cron_expr || '',
              tz: '',
            };
      insert.run(
        `task:${task.id}`,
        task.id,
        task.session_id,
        task.channel_id,
        JSON.stringify(schedule),
        JSON.stringify({ kind: 'agent_turn', message: task.prompt }),
        JSON.stringify({
          kind: 'channel',
          channel: 'session',
          to: task.channel_id,
          webhookUrl: '',
        }),
        task.enabled,
        task.last_run,
        task.last_status === 'success' || task.last_status === 'error'
          ? task.last_status
          : null,
        Math.max(0, Math.floor(task.consecutive_errors || 0)),
        0,
        task.created_at,
      );
    }
  });
  transaction(legacyTasks);
}
