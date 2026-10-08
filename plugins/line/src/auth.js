import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * LINE credential store: `<data dir>/credentials/line/storage.json` plus a
 * sibling `.lock` file owned by one HybridClaw process at a time. The path and
 * storage keys match the pre-plugin core store, so an existing pairing keeps
 * working after the move.
 */

export const LINE_STORAGE_KEYS = Object.freeze({
  authToken: '.hybridclaw:authToken',
  profileMid: '.hybridclaw:profileMid',
  sync: '.hybridclaw:sync',
});

const LINE_STORAGE_FILE_NAME = 'storage.json';
const LINE_AUTH_FILE_MODE = 0o600;

export class LineAuthLockError extends Error {
  /**
   * @param {string} message
   * @param {{ lockPath: string; ownerPid?: number | null }} options
   */
  constructor(message, options) {
    super(message);
    this.name = 'LineAuthLockError';
    this.lockPath = options.lockPath;
    this.ownerPid = options.ownerPid ?? null;
  }
}

/** @param {number} pid */
function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** @param {string} lockPath */
function readLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(lockPath, 'utf-8'));
    return typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid)
      ? parsed.pid
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} authDir
 */
export function createLineAuthStore(authDir) {
  const storagePath = path.join(authDir, LINE_STORAGE_FILE_NAME);
  const lockPath = `${authDir}.lock`;

  const readStorageRecord = () => {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(storagePath, 'utf-8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  };

  /** @param {string} [purpose] */
  const acquireLock = async (purpose = 'runtime') => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fsSync.openSync(lockPath, 'wx', LINE_AUTH_FILE_MODE);
        const metadata = {
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
        if (error?.code !== 'EEXIST') {
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
  };

  const ensureStoragePath = async () => {
    await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
    try {
      await fs.access(storagePath);
    } catch {
      await fs.writeFile(storagePath, '{}', { mode: LINE_AUTH_FILE_MODE });
    }
    await fs.chmod(storagePath, LINE_AUTH_FILE_MODE);
    return storagePath;
  };

  return {
    authDir,
    storagePath,
    lockPath,
    acquireLock,
    ensureStoragePath,
    /** @returns {Promise<{ linked: boolean; mid: string | null }>} */
    async getStatus() {
      const record = readStorageRecord();
      const authToken = record[LINE_STORAGE_KEYS.authToken];
      const mid = record[LINE_STORAGE_KEYS.profileMid];
      return {
        linked: typeof authToken === 'string' && authToken.trim().length > 0,
        mid: typeof mid === 'string' && mid.trim() ? mid.trim() : null,
      };
    },
    async reset() {
      const releaseLock = await acquireLock('reset');
      try {
        await fs.rm(authDir, { recursive: true, force: true });
        await ensureStoragePath();
        return authDir;
      } finally {
        releaseLock();
      }
    },
  };
}
