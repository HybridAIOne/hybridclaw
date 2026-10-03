/**
 * Container end of the file-based IPC with the gateway (`src/infra/ipc.ts`).
 *
 * Output files appear whole: a reader sees no file or complete JSON, never a
 * half-written one. Each request's reply goes to its own file, so a late reply
 * never lands where a later request reads. Input files carry no such
 * guarantee, so the input reader treats unparseable JSON as not yet written
 * and retries after a directory wakeup or periodic reconciliation.
 *
 * `input.json` lives where this agent's own tools can write, so a follow-up is
 * honored only when its authenticity envelope verifies against the per-worker
 * secret received on stdin (`setIpcAuthSecret`, see shared/ipc-input-auth.js);
 * an input that fails to verify is dropped, not run. `health-input.json` is
 * read as a liveness probe only: it yields a turn's input never — just the
 * nonce to echo — so an unauthenticated health file cannot become a turn.
 *
 * The IPC directory can outlive this process: the session's replacement agent
 * may share it while this one shuts down, so once shutdown starts this agent
 * consumes no input file and leaves it for the replacement.
 */
import fs from 'node:fs';
import path from 'node:path';

import { decodeAuthenticatedInput } from '../shared/ipc-input-auth.js';
import { ipcOutputFileName } from '../shared/ipc-output-files.js';
import {
  createIpcWakeup,
  IPC_RECONCILE_INTERVAL_MS,
} from '../shared/ipc-wakeup.js';
import { writeMemoryFileAtomic } from '../shared/memory-file.js';
import { decodeSteerNote, type SteerNote } from '../shared/steer-inbox.js';
import { IPC_DIR } from './runtime-paths.js';
import { isShuttingDown } from './shutdown-latch.js';
import type { ContainerInput, ContainerOutput } from './types.js';

const INPUT_PATH = path.join(IPC_DIR, 'input.json');
const HEALTH_INPUT_PATH = path.join(IPC_DIR, 'health-input.json');
const HEALTH_OUTPUT_PATH = path.join(IPC_DIR, 'health-output.json');
// The per-worker secret from the first stdin payload. Held only in memory here;
// never read from or written to a file.
let ipcAuthSecret = '';

/** Record the secret received on stdin so follow-up inputs can be verified. */
export function setIpcAuthSecret(secret: string): void {
  ipcAuthSecret = secret || '';
}

/** A steering note, verified with the same secret as follow-up inputs. */
export function decodeSteerNoteFile(
  requestId: string,
  raw: string,
): SteerNote | null {
  return decodeSteerNote(ipcAuthSecret, requestId, raw);
}

function readInputFile(inputPath: string): ContainerInput | null {
  let raw: string;
  try {
    raw = fs.readFileSync(inputPath, 'utf-8');
  } catch {
    // Not present yet, retry.
    return null;
  }
  const decoded = decodeAuthenticatedInput(ipcAuthSecret, raw);
  if (decoded.status === 'incomplete') {
    // Partially written, retry without deleting.
    return null;
  }
  if (decoded.status === 'rejected') {
    // A complete but unauthenticated input reached the IPC directory. Drop it
    // so it never becomes a turn, and do not report the reason (untrusted).
    console.error('[ipc] rejected unauthenticated input');
    try {
      fs.unlinkSync(inputPath);
    } catch {
      // already gone
    }
    return null;
  }
  try {
    const input = JSON.parse(decoded.body) as ContainerInput;
    fs.unlinkSync(inputPath);
    return input;
  } catch {
    // Verified envelope with an unparseable body: drop it rather than loop.
    try {
      fs.unlinkSync(inputPath);
    } catch {
      // already gone
    }
    return null;
  }
}

/**
 * Read a health probe. The health path never carries a turn: only a liveness
 * nonce is honored, so an unauthenticated `health-input.json` cannot drive the
 * agent. A file without a nonce is dropped.
 */
function readHealthInputFile(inputPath: string): ContainerInput | null {
  let raw: string;
  try {
    raw = fs.readFileSync(inputPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Partially written, retry without deleting.
    return null;
  }
  const nonce =
    parsed && typeof parsed === 'object'
      ? (parsed as { healthCheck?: { nonce?: unknown } }).healthCheck?.nonce
      : undefined;
  try {
    fs.unlinkSync(inputPath);
  } catch {
    // already gone
  }
  if (typeof nonce !== 'string' || !nonce) return null;
  // Only the nonce is trusted; nothing else in the file reaches a turn.
  return { healthCheck: { nonce } } as ContainerInput;
}

/**
 * Wait for input.json with advisory directory wakeups and periodic checks.
 * Returns null once the idle timeout expires or shutdown starts. The shutdown
 * check and the reads after it run synchronously, so they cannot race shutdown.
 */
export async function waitForInput(
  idleTimeoutMs: number,
): Promise<ContainerInput | null> {
  const deadline = Date.now() + idleTimeoutMs;
  const wakeup = createIpcWakeup(IPC_DIR);

  try {
    while (!isShuttingDown() && Date.now() < deadline) {
      if (fs.existsSync(HEALTH_INPUT_PATH)) {
        const input = readHealthInputFile(HEALTH_INPUT_PATH);
        if (input) return input;
      }
      if (fs.existsSync(INPUT_PATH)) {
        const input = readInputFile(INPUT_PATH);
        if (input) return input;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await wakeup.wait(Math.min(IPC_RECONCILE_INTERVAL_MS, remainingMs));
    }

    return null; // Idle timeout or shutdown
  } finally {
    wakeup.close();
  }
}

export function writeOutput(
  output: ContainerOutput,
  requestId: string | undefined,
): void {
  writeMemoryFileAtomic(
    path.join(IPC_DIR, ipcOutputFileName(requestId)),
    JSON.stringify(output),
  );
}

export function writeHealthOutput(output: ContainerOutput): void {
  writeMemoryFileAtomic(HEALTH_OUTPUT_PATH, JSON.stringify(output));
}
