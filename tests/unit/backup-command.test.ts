import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as yauzl from 'yauzl';
import { useCleanMocks, useTempDir } from '../test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-backup-test-');

useCleanMocks({ resetModules: true, unstubAllEnvs: true });

function writeBaseRuntimeHome(homeDir: string): void {
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, 'config.json'),
    JSON.stringify({ version: 1, agent: 'main' }, null, 2),
    'utf-8',
  );
  fs.writeFileSync(path.join(homeDir, 'credentials.json'), '{}', 'utf-8');
  fs.mkdirSync(path.join(homeDir, 'data'), { recursive: true });
}

function writeSampleSqlite(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.prepare(
      'CREATE TABLE IF NOT EXISTS backup_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    db.prepare('INSERT INTO backup_probe (value) VALUES (?), (?)').run(
      'alpha',
      'beta',
    );
  } finally {
    db.close();
  }
}

function listZipEntries(archivePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) return reject(error ?? new Error('open failed'));
      const names: string[] = [];
      zipFile.on('error', reject);
      zipFile.on('end', () => resolve(names));
      zipFile.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.readEntry();
    });
  });
}

async function loadBackupModule(homeDir: string) {
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', homeDir);
  vi.resetModules();
  return import('../../src/cli/backup-command.ts');
}

describe('createBackupArchive', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('creates a zip archive with manifest and runtime contents', async () => {
    const baseDir = makeTempDir();
    const homeDir = path.join(baseDir, '.hybridclaw');
    writeBaseRuntimeHome(homeDir);
    writeSampleSqlite(path.join(homeDir, 'data', 'hybridclaw.db'));

    const outputDir = makeTempDir();
    const outputPath = path.join(outputDir, 'backup.zip');

    const { createBackupArchive } = await loadBackupModule(homeDir);
    const result = await createBackupArchive({
      sourceDir: homeDir,
      outputPath,
      now: new Date('2026-04-22T10:00:00.000Z'),
    });

    expect(result.archivePath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(result.manifest.formatVersion).toBe(1);
    expect(result.manifest.sqliteSnapshots).toContain('data/hybridclaw.db');

    const entries = await listZipEntries(outputPath);
    expect(entries).toContain('hybridclaw-backup.json');
    expect(entries).toContain('hybridclaw/config.json');
    expect(entries).toContain('hybridclaw/credentials.json');
    expect(entries).toContain('hybridclaw/data/hybridclaw.db');
  });

  test('excludes WAL sidecars, PID files, and cache directories', async () => {
    const baseDir = makeTempDir();
    const homeDir = path.join(baseDir, '.hybridclaw');
    writeBaseRuntimeHome(homeDir);
    fs.writeFileSync(path.join(homeDir, 'data', 'hybridclaw.db-wal'), 'wal');
    fs.writeFileSync(path.join(homeDir, 'data', 'hybridclaw.db-shm'), 'shm');
    fs.writeFileSync(path.join(homeDir, 'gateway.pid'), '12345');
    fs.mkdirSync(path.join(homeDir, 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, 'cache', 'stale.bin'),
      'should-not-be-packed',
    );
    fs.mkdirSync(path.join(homeDir, 'evals'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'evals', 'run.log'), 'trace');

    const outputPath = path.join(makeTempDir(), 'backup.zip');
    const { createBackupArchive } = await loadBackupModule(homeDir);
    await createBackupArchive({ sourceDir: homeDir, outputPath });

    const entries = await listZipEntries(outputPath);
    expect(entries).not.toContain('hybridclaw/data/hybridclaw.db-wal');
    expect(entries).not.toContain('hybridclaw/data/hybridclaw.db-shm');
    expect(entries).not.toContain('hybridclaw/gateway.pid');
    expect(entries.some((name) => name.startsWith('hybridclaw/cache/'))).toBe(
      false,
    );
    expect(entries.some((name) => name.startsWith('hybridclaw/evals/'))).toBe(
      false,
    );
  });

  test('produces a WAL-consistent SQLite snapshot usable by better-sqlite3', async () => {
    const baseDir = makeTempDir();
    const homeDir = path.join(baseDir, '.hybridclaw');
    writeBaseRuntimeHome(homeDir);
    const dbPath = path.join(homeDir, 'data', 'hybridclaw.db');
    writeSampleSqlite(dbPath);

    const outputPath = path.join(makeTempDir(), 'backup.zip');
    const { createBackupArchive, restoreBackupArchive } =
      await loadBackupModule(homeDir);

    await createBackupArchive({ sourceDir: homeDir, outputPath });

    const restoreTarget = path.join(makeTempDir(), '.hybridclaw-restored');
    await restoreBackupArchive({
      archivePath: outputPath,
      targetDir: restoreTarget,
      force: true,
    });

    const restoredDbPath = path.join(restoreTarget, 'data', 'hybridclaw.db');
    expect(fs.existsSync(restoredDbPath)).toBe(true);

    const db = new Database(restoredDbPath, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT value FROM backup_probe ORDER BY id')
        .all() as Array<{ value: string }>;
      expect(rows.map((row) => row.value)).toEqual(['alpha', 'beta']);
    } finally {
      db.close();
    }
  });
});

describe('restoreBackupArchive', () => {
  test('refuses to overwrite an existing runtime home without --force or confirmation', async () => {
    const baseDir = makeTempDir();
    const homeDir = path.join(baseDir, '.hybridclaw');
    writeBaseRuntimeHome(homeDir);

    const outputPath = path.join(makeTempDir(), 'backup.zip');
    const { createBackupArchive, restoreBackupArchive } =
      await loadBackupModule(homeDir);
    await createBackupArchive({ sourceDir: homeDir, outputPath });

    const restoreTarget = path.join(makeTempDir(), '.hybridclaw-target');
    writeBaseRuntimeHome(restoreTarget);
    fs.writeFileSync(
      path.join(restoreTarget, 'config.json'),
      '{"preserved":true}',
      'utf-8',
    );

    await expect(
      restoreBackupArchive({
        archivePath: outputPath,
        targetDir: restoreTarget,
        confirm: () => false,
      }),
    ).rejects.toThrow(/already contains/);

    const preserved = JSON.parse(
      fs.readFileSync(path.join(restoreTarget, 'config.json'), 'utf-8'),
    );
    expect(preserved.preserved).toBe(true);
  });

  test('restores when the user confirms the overwrite', async () => {
    const baseDir = makeTempDir();
    const homeDir = path.join(baseDir, '.hybridclaw');
    writeBaseRuntimeHome(homeDir);
    fs.writeFileSync(
      path.join(homeDir, 'config.json'),
      '{"fromBackup":true}',
      'utf-8',
    );

    const outputPath = path.join(makeTempDir(), 'backup.zip');
    const { createBackupArchive, restoreBackupArchive } =
      await loadBackupModule(homeDir);
    await createBackupArchive({ sourceDir: homeDir, outputPath });

    const restoreTarget = path.join(makeTempDir(), '.hybridclaw-target');
    writeBaseRuntimeHome(restoreTarget);
    fs.writeFileSync(
      path.join(restoreTarget, 'config.json'),
      '{"old":true}',
      'utf-8',
    );

    const confirm = vi.fn().mockReturnValue(true);
    const result = await restoreBackupArchive({
      archivePath: outputPath,
      targetDir: restoreTarget,
      confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.replaced).toBe(true);
    const restoredConfig = JSON.parse(
      fs.readFileSync(path.join(restoreTarget, 'config.json'), 'utf-8'),
    );
    expect(restoredConfig.fromBackup).toBe(true);
  });

  test('rejects archives without the backup manifest', async () => {
    const yazl = await import('yazl');
    const archivePath = path.join(makeTempDir(), 'not-a-backup.zip');
    await new Promise<void>((resolve, reject) => {
      const zipFile = new yazl.ZipFile();
      const output = fs.createWriteStream(archivePath);
      output.on('close', () => resolve());
      output.on('error', reject);
      zipFile.outputStream.on('error', reject).pipe(output);
      zipFile.addBuffer(Buffer.from('hi', 'utf-8'), 'readme.txt');
      zipFile.end();
    });

    const homeDir = path.join(makeTempDir(), '.hybridclaw');
    writeBaseRuntimeHome(homeDir);
    const { restoreBackupArchive } = await loadBackupModule(homeDir);

    await expect(
      restoreBackupArchive({
        archivePath,
        targetDir: path.join(makeTempDir(), '.hybridclaw-target'),
        force: true,
      }),
    ).rejects.toThrow(/missing hybridclaw-backup\.json/);
  });
});
