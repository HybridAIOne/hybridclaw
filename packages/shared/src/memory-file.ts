/**
 * Cooperative memory-file transactions shared by host and container processes.
 * Locks cover the entire read/modify/write; rename alone cannot prevent lost updates.
 * Recovery requires a confirmed dead owner in this process's boot/PID namespace.
 * This is not a workspace access policy and cannot serialize external editors.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { writeFileAtomic } from './atomic-write.ts';

// 5s/25ms (implementation decision, 2026-09-08, issue #1477): bounded contention.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;
// 1 KiB (implementation decision, 2026-11-08): bound inspection of corrupt owners.
const MAX_OWNER_BYTES = 1_024;
const OWNER_NAMESPACE = ownerNamespace();

function ownerNamespace(): string | null {
  try {
    if (process.platform === 'linux') {
      const boot = fs
        .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
        .trim();
      const namespace = fs.readlinkSync('/proc/self/ns/pid');
      if (/^[0-9a-f-]{36}$/i.test(boot) && /^pid:\[\d+\]$/.test(namespace))
        return `linux:${boot}:${namespace}`;
    }
    if (process.platform === 'darwin') {
      // 1s (implementation decision, 2026-11-08): namespace probing stays bounded.
      const boot = execFileSync(
        '/usr/sbin/sysctl',
        ['-n', 'kern.bootsessionuuid'],
        {
          encoding: 'utf8',
          timeout: 1_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
      if (/^[0-9a-f-]{36}$/i.test(boot)) return `darwin:${boot}`;
    }
  } catch {}
  return null;
}

export function lockMemoryFile(filePath: string): () => void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt > 0 || !removeDeadOwner(lockPath)) {
        throw new Error(`Memory file is locked: ${filePath}. Retry later.`);
      }
    }
  }
  const ownerPath = path.join(lockPath, `owner-${randomUUID()}.json`);
  try {
    fs.writeFileSync(
      ownerPath,
      JSON.stringify({ pid: process.pid, namespace: OWNER_NAMESPACE }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (err) {
    // Do not recursively delete an incomplete or externally changed lock.
    try {
      fs.rmdirSync(lockPath);
    } catch {}
    throw err;
  }
  return () => {
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
  };
}

function removeDeadOwner(lockPath: string): boolean {
  try {
    if (!OWNER_NAMESPACE || !fs.lstatSync(lockPath).isDirectory()) return false;
    const entries = fs.readdirSync(lockPath);
    if (entries.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/.test(entries[0]))
      return false;
    const ownerPath = path.join(lockPath, entries[0]);
    const stat = fs.lstatSync(ownerPath);
    if (!stat.isFile() || stat.size > MAX_OWNER_BYTES) return false;
    const owner: { pid: number; namespace?: unknown } | null = JSON.parse(
      fs.readFileSync(ownerPath, 'utf8'),
    );
    if (
      !owner ||
      owner.namespace !== OWNER_NAMESPACE ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    // Only one reaper can unlink this owner's unique entry. A losing reaper
    // must never rmdir a directory that a new writer may already have acquired.
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export async function waitForMemoryFileLock(
  filePath: string,
): Promise<() => void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return lockMemoryFile(filePath);
    } catch (err) {
      if (
        !(err as Error).message.startsWith('Memory file is locked:') ||
        Date.now() >= deadline
      )
        throw err;
      await setTimeout(LOCK_RETRY_MS);
    }
  }
}

// Approval evaluation is synchronous; wait only for another process's writer.
export function waitForMemoryFileLockSync(filePath: string): () => void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return lockMemoryFile(filePath);
    } catch (err) {
      if (
        !(err as Error).message.startsWith('Memory file is locked:') ||
        Date.now() >= deadline
      )
        throw err;
      Atomics.wait(pause, 0, 0, LOCK_RETRY_MS);
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
