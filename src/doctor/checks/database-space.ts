/**
 * Database space check — gives back disk space that deleted rows leave inside
 * the SQLite file.
 *
 * Deleting rows only frees pages inside the file; the file shrinks only on
 * VACUUM. The fix drops request logs past retention, then VACUUMs once free
 * pages are a large share of the file. VACUUM rewrites the live pages through
 * the WAL next to the database, so it is skipped when that disk cannot hold
 * them.
 *
 * NOT startup integrity recovery (`memory/database.ts`); this only runs from
 * doctor and the resource-hygiene job against an open, healthy database.
 */
import Database from 'better-sqlite3';
import { DB_PATH } from '../../config/config.js';
import {
  deleteExpiredRequestLogs,
  requestLogCutoff,
} from '../../memory/usage.js';
import type { DiagResult } from '../types.js';
import { formatBytes, makeResult, readDiskFreeBytes } from '../utils.js';

// 25% and 16 MiB (maintainer call, 2026-10-15): below that, later writes reuse
// the free pages anyway, and a full rewrite is not worth it.
const VACUUM_MIN_FREE_RATIO = 0.25;
const VACUUM_MIN_FREE_BYTES = 16 * 1024 * 1024;
const LABEL = 'Database space';

interface DatabaseSpace {
  expiredRequestLogs: number;
  freeBytes: number;
  liveBytes: number;
}

function readDatabaseSpace(database: Database.Database): DatabaseSpace {
  const pageSize = database.pragma('page_size', { simple: true }) as number;
  const pageCount = database.pragma('page_count', { simple: true }) as number;
  const freePages = database.pragma('freelist_count', {
    simple: true,
  }) as number;
  const { count } = database
    .prepare('SELECT COUNT(*) AS count FROM request_log WHERE created_at < ?')
    .get(requestLogCutoff()) as { count: number };
  return {
    expiredRequestLogs: count,
    freeBytes: freePages * pageSize,
    liveBytes: (pageCount - freePages) * pageSize,
  };
}

function worthVacuum(space: DatabaseSpace): boolean {
  return (
    space.freeBytes >= VACUUM_MIN_FREE_BYTES &&
    space.freeBytes >=
      (space.freeBytes + space.liveBytes) * VACUUM_MIN_FREE_RATIO
  );
}

function reclaimDatabaseSpace(): void {
  const database = new Database(DB_PATH, { fileMustExist: true });
  try {
    database.pragma('busy_timeout = 5000');
    deleteExpiredRequestLogs(database);
    const space = readDatabaseSpace(database);
    if (!worthVacuum(space)) return;
    const diskFreeBytes = readDiskFreeBytes(DB_PATH);
    if (diskFreeBytes == null || diskFreeBytes < space.liveBytes) {
      throw new Error(
        `VACUUM needs ${formatBytes(space.liveBytes)} free next to the database; ${diskFreeBytes == null ? 'free space is unknown' : `${formatBytes(diskFreeBytes)} is free`}`,
      );
    }
    database.exec('VACUUM');
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
}

export async function checkDatabaseSpace(): Promise<DiagResult[]> {
  const database = new Database(DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  let space: DatabaseSpace;
  try {
    space = readDatabaseSpace(database);
  } finally {
    database.close();
  }
  if (space.expiredRequestLogs === 0 && !worthVacuum(space)) {
    return [
      makeResult(
        'database',
        LABEL,
        'ok',
        `${formatBytes(space.freeBytes)} free inside the database`,
      ),
    ];
  }
  return [
    makeResult(
      'database',
      LABEL,
      'warn',
      `${space.expiredRequestLogs} expired request logs, ${formatBytes(space.freeBytes)} free inside the database`,
      {
        summary: 'Delete expired request logs and VACUUM the database',
        requiresApproval: false,
        apply: async () => reclaimDatabaseSpace(),
      },
    ),
  ];
}
