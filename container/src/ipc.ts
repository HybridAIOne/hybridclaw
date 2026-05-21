import fs from 'node:fs';
import path from 'node:path';

import { IPC_DIR } from './runtime-paths.js';
import type { ContainerInput, ContainerOutput } from './types.js';

const INPUT_PATH = path.join(IPC_DIR, 'input.json');
const OUTPUT_PATH = path.join(IPC_DIR, 'output.json');
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
 * Poll for input.json. Returns null if idle timeout expires.
 */
export async function waitForInput(
  idleTimeoutMs: number,
): Promise<ContainerInput | null> {
  const deadline = Date.now() + idleTimeoutMs;
  let pollInterval = MIN_INPUT_POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
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

  return null; // Idle timeout
}

export function writeOutput(output: ContainerOutput): void {
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
}

export function writeHealthOutput(output: ContainerOutput): void {
  fs.writeFileSync(HEALTH_OUTPUT_PATH, JSON.stringify(output, null, 2));
}
