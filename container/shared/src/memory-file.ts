/**
 * Cooperative memory-file transactions shared by host and container processes.
 * Locks cover the entire read/modify/write; rename alone cannot prevent lost updates.
 * This is not a workspace access policy and cannot serialize external editors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { writeFileAtomic } from './atomic-write.js';

export function lockMemoryFile(filePath: string): () => void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  try {
    fs.mkdirSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Memory file is locked: ${filePath}. Retry later; after a crashed writer, remove the .lock directory only when no writer is running.`,
      );
    }
    throw err;
  }
  return () => fs.rmdirSync(lockPath);
}

export async function waitForMemoryFileLock(
  filePath: string,
): Promise<() => void> {
  // 5s/25ms (implementation decision, 2026-09-08, issue #1477): bound tool
  // contention without blocking the event loop; automatic stale-lock stealing deferred.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return lockMemoryFile(filePath);
    } catch (err) {
      if (
        !(err as Error).message.startsWith('Memory file is locked:') ||
        Date.now() >= deadline
      )
        throw err;
      await setTimeout(25);
    }
  }
}

export function writeMemoryFileAtomic(filePath: string, content: string): void {
  let mode: number | undefined;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {}
  writeFileAtomic(filePath, content, { mode });
}
