/**
 * Container end of the file-based IPC with the gateway (`src/infra/ipc.ts`).
 *
 * Output files appear whole: a poller sees no file or complete JSON, never a
 * half-written one. Each request's reply goes to its own file, so a late reply
 * never lands where a later request reads. Input files carry no such
 * guarantee, so the input reader treats unparseable JSON as not yet written
 * and polls again.
 *
 * The IPC directory can outlive this process: the session's replacement agent
 * may share it while this one shuts down, so once shutdown starts this agent
 * consumes no input file and leaves it for the replacement.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ipcOutputFileName } from '../shared/ipc-output-files.js';
import { writeMemoryFileAtomic } from '../shared/memory-file.js';
import { IPC_DIR } from './runtime-paths.js';
import { isShuttingDown } from './shutdown-latch.js';
import type { ContainerInput, ContainerOutput } from './types.js';

const INPUT_PATH = path.join(IPC_DIR, 'input.json');
const HEALTH_INPUT_PATH = path.join(IPC_DIR, 'health-input.json');
const HEALTH_OUTPUT_PATH = path.join(IPC_DIR, 'health-output.json');
const MIN_INPUT_POLL_INTERVAL_MS = 5;
const MAX_INPUT_POLL_INTERVAL_MS = 200;
// Keep the backoff formula aligned with src/infra/ipc.ts; max differs by side.
const INPUT_POLL_BACKOFF_FACTOR = 1.5;

function readInputFile(inputPath: string): ContainerInput | null {
  try {
    const raw = fs.readFileSync(inputPath, 'utf-8');
    const input = JSON.parse(raw) as ContainerInput;
    // Remove input file to signal we've consumed it
    fs.unlinkSync(inputPath);
    return input;
  } catch {
    // Partially written, retry
    return null;
  }
}

/**
 * Poll for input.json. Returns null once the idle timeout expires or shutdown
 * starts. The shutdown check and the reads after it run in one synchronous
 * step, so no shutdown can start between them.
 */
export async function waitForInput(
  idleTimeoutMs: number,
): Promise<ContainerInput | null> {
  const deadline = Date.now() + idleTimeoutMs;
  let pollInterval = MIN_INPUT_POLL_INTERVAL_MS;

  while (!isShuttingDown() && Date.now() < deadline) {
    if (fs.existsSync(HEALTH_INPUT_PATH)) {
      const input = readInputFile(HEALTH_INPUT_PATH);
      if (input) return input;
    }
    if (fs.existsSync(INPUT_PATH)) {
      const input = readInputFile(INPUT_PATH);
      if (input) return input;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollInterval, remainingMs)),
    );
    pollInterval = Math.min(
      Math.ceil(pollInterval * INPUT_POLL_BACKOFF_FACTOR),
      MAX_INPUT_POLL_INTERVAL_MS,
    );
  }

  return null; // Idle timeout or shutdown
}

export function writeOutput(
  output: ContainerOutput,
  requestId: string | undefined,
): void {
  writeMemoryFileAtomic(
    path.join(IPC_DIR, ipcOutputFileName(requestId)),
    JSON.stringify(output, null, 2),
  );
}

export function writeHealthOutput(output: ContainerOutput): void {
  writeMemoryFileAtomic(HEALTH_OUTPUT_PATH, JSON.stringify(output, null, 2));
}
