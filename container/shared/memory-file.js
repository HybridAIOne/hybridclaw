/**
 * Cooperative memory-file transactions shared by host and container processes.
 * Locks cover the entire read/modify/write; rename alone cannot prevent lost updates.
 * This is not a workspace access policy and cannot serialize external editors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { writeFileAtomic } from './atomic-write.js';

// 5s/25ms (implementation decision, 2026-09-08, issue #1477): bounded
// contention; automatic stale-lock stealing remains deferred.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

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
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return lockMemoryFile(filePath);
    } catch (err) {
      if (
        !err.message.startsWith('Memory file is locked:') ||
        Date.now() >= deadline
      )
        throw err;
      await setTimeout(LOCK_RETRY_MS);
    }
  }
}

// Approval evaluation is synchronous; wait only for another process's writer.
export function waitForMemoryFileLockSync(filePath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return lockMemoryFile(filePath);
    } catch (err) {
      if (
        !err.message.startsWith('Memory file is locked:') ||
        Date.now() >= deadline
      )
        throw err;
      Atomics.wait(pause, 0, 0, LOCK_RETRY_MS);
    }
  }
}

export function writeMemoryFileAtomic(filePath, content) {
  let mode;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {}
  writeFileAtomic(filePath, content, { mode });
}
