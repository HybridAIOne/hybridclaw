import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempHome = useTempDir('hybridclaw-db-space-');
useCleanMocks({ resetModules: true, unstubAllEnvs: true });

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(async () => {
  const { closeDatabase } = await import('../src/memory/db.ts');
  closeDatabase();
});

async function setupDatabaseWithExpiredRequestLogs(): Promise<string> {
  vi.stubEnv('HOME', makeTempHome());
  const { DB_PATH } = await import('../src/config/config.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const seed = new Database(DB_PATH);
  const insert = seed.prepare(
    'INSERT INTO request_log (session_id, messages_json, created_at) VALUES (?, ?, ?)',
  );
  const payload = 'x'.repeat(120 * 1024);
  const expiredAt = new Date(Date.now() - 8 * DAY_MS).toISOString();
  seed.transaction(() => {
    for (let i = 0; i < 200; i++) insert.run('session-old', payload, expiredAt);
    insert.run('session-recent', payload, new Date().toISOString());
  })();
  seed.pragma('wal_checkpoint(TRUNCATE)');
  seed.close();
  return DB_PATH;
}

function requestLogSessions(dbPath: string): string[] {
  const inspect = new Database(dbPath, { readonly: true });
  const rows = inspect
    .prepare('SELECT DISTINCT session_id FROM request_log ORDER BY session_id')
    .all() as Array<{ session_id: string }>;
  inspect.close();
  return rows.map((row) => row.session_id);
}

test('database space fix deletes expired request logs and shrinks the file', async () => {
  const dbPath = await setupDatabaseWithExpiredRequestLogs();
  const sizeBefore = fs.statSync(dbPath).size;
  const { checkDatabaseSpace } = await import(
    '../src/doctor/checks/database-space.ts'
  );

  const [result] = await checkDatabaseSpace();
  expect(result).toMatchObject({ label: 'Database space', severity: 'warn' });
  await result.fix?.apply();

  expect(requestLogSessions(dbPath)).toEqual(['session-recent']);
  expect(fs.statSync(dbPath).size).toBeLessThan(sizeBefore / 4);
  const [after] = await checkDatabaseSpace();
  expect(after.severity).toBe('ok');
});

test('database space fix skips VACUUM when the disk cannot hold the rewrite', async () => {
  const dbPath = await setupDatabaseWithExpiredRequestLogs();
  const sizeBefore = fs.statSync(dbPath).size;
  const utils = await import('../src/doctor/utils.ts');
  vi.doMock('../src/doctor/utils.js', () => ({
    ...utils,
    readDiskFreeBytes: () => 1024,
  }));
  const { checkDatabaseSpace } = await import(
    '../src/doctor/checks/database-space.ts'
  );

  const [result] = await checkDatabaseSpace();
  await expect(result.fix?.apply()).rejects.toThrow(/VACUUM needs/);

  expect(requestLogSessions(dbPath)).toEqual(['session-recent']);
  expect(fs.statSync(dbPath).size).toBe(sizeBefore);
});
