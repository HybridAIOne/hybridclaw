import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];
const tempPaths: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-hygiene-'));
  tempDirs.push(dir);
  return dir;
}

function rememberPath(targetPath: string): string {
  tempPaths.push(targetPath);
  return targetPath;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function setOldMtime(targetPath: string, ageMs: number): void {
  const date = new Date(Date.now() - ageMs);
  fs.utimesSync(targetPath, date, date);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempPaths.length > 0) {
    const targetPath = tempPaths.pop();
    if (!targetPath) continue;
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('old temp media check prunes only managed temp directories older than 24h', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const oldDir = rememberPath(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-wa-')),
  );
  const recentDir = rememberPath(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-slack-')),
  );
  fs.writeFileSync(path.join(oldDir, 'stale.txt'), 'stale');
  fs.writeFileSync(path.join(recentDir, 'recent.txt'), 'recent');
  setOldMtime(path.join(oldDir, 'stale.txt'), 2 * 24 * 60 * 60 * 1000);
  setOldMtime(oldDir, 2 * 24 * 60 * 60 * 1000);

  const { checkOldTempMedia } = await import(
    '../src/doctor/checks/resource-hygiene.ts'
  );

  const [result] = await checkOldTempMedia();

  expect(result).toMatchObject({
    label: 'Old temp media',
    severity: 'warn',
  });
  await result.fix?.apply();

  expect(fs.existsSync(oldDir)).toBe(false);
  expect(fs.existsSync(recentDir)).toBe(true);
});

test('stale workspace check separates safe orphaned workspaces from git-backed ones', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { DATA_DIR } = await import('../src/config/config.ts');
  initDatabase({ quiet: true });

  const safeWorkspaceRoot = rememberPath(
    path.join(DATA_DIR, 'agents', 'orphan-safe'),
  );
  const riskyWorkspaceRoot = rememberPath(
    path.join(DATA_DIR, 'agents', 'orphan-git'),
  );
  fs.mkdirSync(path.join(safeWorkspaceRoot, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(safeWorkspaceRoot, 'workspace', 'note.txt'), 'x');
  fs.mkdirSync(path.join(riskyWorkspaceRoot, 'workspace', '.git'), {
    recursive: true,
  });
  setOldMtime(path.join(safeWorkspaceRoot, 'workspace', 'note.txt'), 8 * 24 * 60 * 60 * 1000);
  setOldMtime(path.join(riskyWorkspaceRoot, 'workspace', '.git'), 8 * 24 * 60 * 60 * 1000);
  setOldMtime(safeWorkspaceRoot, 8 * 24 * 60 * 60 * 1000);
  setOldMtime(riskyWorkspaceRoot, 8 * 24 * 60 * 60 * 1000);

  const { checkStaleWorkspaces } = await import(
    '../src/doctor/checks/resource-hygiene.ts'
  );

  const results = await checkStaleWorkspaces();
  const safeResult = results.find(
    (result) => result.label === 'Stale workspaces',
  );
  const riskyResult = results.find(
    (result) => result.label === 'Git-backed stale workspaces',
  );

  expect(safeResult).toMatchObject({
    severity: 'warn',
  });
  expect(riskyResult).toMatchObject({
    severity: 'error',
    fix: expect.objectContaining({
      requiresApproval: true,
    }),
  });

  await safeResult?.fix?.apply();

  expect(fs.existsSync(safeWorkspaceRoot)).toBe(false);
  expect(fs.existsSync(riskyWorkspaceRoot)).toBe(true);
});

test('session compaction backlog fix compacts oversized idle sessions', async () => {
  const maybeCompactSessionMock = vi.fn(async () => {});
  vi.doMock('../src/session/session-maintenance.js', () => ({
    maybeCompactSession: maybeCompactSessionMock,
  }));

  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, getOrCreateSession } = await import('../src/memory/db.ts');
  const { DB_PATH } = await import('../src/config/config.ts');

  initDatabase({ quiet: true });
  const session = getOrCreateSession('session-backlog', null, 'web', 'main');
  const db = new Database(DB_PATH);
  db.prepare(
    'UPDATE sessions SET message_count = ?, last_active = ? WHERE id = ?',
  ).run(250, '2026-04-01T00:00:00.000Z', session.id);
  db.close();

  const { checkSessionCompactionBacklog } = await import(
    '../src/doctor/checks/resource-hygiene.ts'
  );

  const [result] = await checkSessionCompactionBacklog();

  expect(result).toMatchObject({
    label: 'Session compaction backlog',
    severity: 'warn',
  });

  await result.fix?.apply();

  expect(maybeCompactSessionMock).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: session.id,
      channelId: 'web',
    }),
  );
});
