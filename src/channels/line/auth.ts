import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RUNTIME_HOME_DIR } from '../../config/runtime-paths.js';

export const LINE_AUTH_DIR = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'credentials',
  'line',
);
export const LINE_AUTH_STORAGE_KEY = '.hybridclaw:authToken';
export const LINE_PROFILE_MID_STORAGE_KEY = '.hybridclaw:profileMid';
export const LINE_SYNC_STORAGE_KEY = '.hybridclaw:sync';
export const LINE_STORAGE_FILE_NAME = 'storage.json';

const LINE_AUTH_FILE_MODE = 0o600;

interface LineAuthLockMetadata {
  pid: number;
  startedAt: string;
  purpose: string;
}

export class LineAuthLockError extends Error {
  readonly lockPath: string;
  readonly ownerPid: number | null;

  constructor(
    message: string,
    options: { lockPath: string; ownerPid?: number | null },
  ) {
    super(message);
    this.name = 'LineAuthLockError';
    this.lockPath = options.lockPath;
    this.ownerPid = options.ownerPid ?? null;
  }
}

export function lineAuthStoragePath(authDir = LINE_AUTH_DIR): string {
  return path.join(authDir, LINE_STORAGE_FILE_NAME);
}

export function lineAuthLockPath(authDir = LINE_AUTH_DIR): string {
  return `${authDir}.lock`;
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockOwner(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(
      fsSync.readFileSync(lockPath, 'utf-8'),
    ) as Partial<LineAuthLockMetadata>;
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)
      ? parsed.pid
      : null;
  } catch {
    return null;
  }
}

export async function acquireLineAuthLock(
  authDir = LINE_AUTH_DIR,
  purpose = 'runtime',
): Promise<() => void> {
  const lockPath = lineAuthLockPath(authDir);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fsSync.openSync(lockPath, 'wx', LINE_AUTH_FILE_MODE);
      const metadata: LineAuthLockMetadata = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        purpose,
      };
      fsSync.writeFileSync(fd, `${JSON.stringify(metadata, null, 2)}\n`);
      fsSync.closeSync(fd);
      return () => {
        try {
          fsSync.rmSync(lockPath, { force: true });
        } catch {
          // Best effort: a stale lock is reclaimed on the next acquisition.
        }
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw new LineAuthLockError(
          `Failed to acquire LINE auth lock at ${lockPath}.`,
          { lockPath },
        );
      }

      const ownerPid = readLockOwner(lockPath);
      if (ownerPid != null && isProcessRunning(ownerPid)) {
        throw new LineAuthLockError(
          `LINE auth state is already in use by pid ${ownerPid}. Stop the other HybridClaw process before pairing or resetting LINE.`,
          { lockPath, ownerPid },
        );
      }
      await fs.rm(lockPath, { force: true });
    }
  }

  throw new LineAuthLockError(
    `Failed to reclaim stale LINE auth lock at ${lockPath}.`,
    { lockPath },
  );
}

export async function ensureLineAuthStoragePath(
  authDir = LINE_AUTH_DIR,
): Promise<string> {
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  const storagePath = lineAuthStoragePath(authDir);
  try {
    await fs.access(storagePath);
  } catch {
    await fs.writeFile(storagePath, '{}', { mode: LINE_AUTH_FILE_MODE });
  }
  await fs.chmod(storagePath, LINE_AUTH_FILE_MODE);
  return storagePath;
}

function readLineStorageRecord(
  authDir = LINE_AUTH_DIR,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(
      fsSync.readFileSync(lineAuthStoragePath(authDir), 'utf-8'),
    ) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function getLineAuthStatus(authDir = LINE_AUTH_DIR): Promise<{
  linked: boolean;
  mid: string | null;
}> {
  const record = readLineStorageRecord(authDir);
  const authToken = record[LINE_AUTH_STORAGE_KEY];
  const mid = record[LINE_PROFILE_MID_STORAGE_KEY];
  return {
    linked: typeof authToken === 'string' && authToken.trim().length > 0,
    mid: typeof mid === 'string' && mid.trim() ? mid.trim() : null,
  };
}

export async function resetLineAuthState(
  authDir = LINE_AUTH_DIR,
): Promise<string> {
  const releaseLock = await acquireLineAuthLock(authDir, 'reset');
  try {
    await fs.rm(authDir, { recursive: true, force: true });
    return await ensureLineAuthStoragePath(authDir);
  } finally {
    releaseLock();
  }
}
