import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

let tempDir: string | null = null;
const ORIGINAL_HOME = process.env.HOME;

afterEach(() => {
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function auditTimestampIndex(dbPath: string): { name: string } | undefined {
  const database = new Database(dbPath, { readonly: true });
  try {
    return database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get('idx_audit_events_timestamp') as { name: string } | undefined;
  } finally {
    database.close();
  }
}

// Regression guard: the timestamp index lives in migrateV38, NOT migrateV1.
// migrateV1 only runs on a brand-new (v0) database, so an index added there
// would never reach the existing deployments that need it. This test proves
// a database that predates V38 picks the index up on the next boot.
test('migrateV38 adds idx_audit_events_timestamp to a pre-V38 database', async () => {
  tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-audit-index-migration-'),
  );
  process.env.HOME = tempDir;
  const dbPath = path.join(tempDir, 'hybridclaw.db');

  const { initDatabase } = await import('../src/memory/db.ts');

  // 1. Build a complete, current-schema database.
  initDatabase({ quiet: true, dbPath });
  expect(auditTimestampIndex(dbPath)).toEqual({
    name: 'idx_audit_events_timestamp',
  });

  // 2. Simulate a database created before migrateV38: drop the index and
  //    roll user_version back one step so the next boot re-runs migrations.
  const downgrade = new Database(dbPath);
  downgrade.prepare('DROP INDEX IF EXISTS idx_audit_events_timestamp').run();
  downgrade.pragma('user_version = 37');
  downgrade.close();
  expect(auditTimestampIndex(dbPath)).toBeUndefined();

  // 3. Re-initialise, as a fresh process boot would.
  initDatabase({ quiet: true, dbPath });

  // 4. The index is back even though migrateV1 never re-runs.
  expect(auditTimestampIndex(dbPath)).toEqual({
    name: 'idx_audit_events_timestamp',
  });
});
