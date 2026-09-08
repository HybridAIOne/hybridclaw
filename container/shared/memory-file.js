/**
 * Cooperative memory-file transactions shared by host and container processes.
 * Locks cover the entire read/modify/write; rename alone cannot prevent lost updates.
 * This is not a workspace access policy and cannot serialize external editors.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

export function lockMemoryFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  try {
    fs.mkdirSync(lockPath);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(
        `Memory file is locked: ${filePath}. Retry later; after a crashed writer, remove the .lock directory only when no writer is running.`,
      );
    }
    throw err;
  }
  return () => fs.rmdirSync(lockPath);
}

export async function waitForMemoryFileLock(filePath) {
  // 5s/25ms (implementation decision, 2026-09-08, issue #1477): bound tool
  // contention without blocking the event loop; automatic stale-lock stealing deferred.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return lockMemoryFile(filePath);
    } catch (err) {
      if (
        !err.message.startsWith('Memory file is locked:') ||
        Date.now() >= deadline
      )
        throw err;
      await setTimeout(25);
    }
  }
}

export function writeMemoryFileAtomic(filePath, content) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
