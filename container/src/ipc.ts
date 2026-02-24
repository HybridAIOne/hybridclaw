import fs from 'fs';
import path from 'path';

import type { ContainerInput, ContainerOutput } from './types.js';

const IPC_DIR = '/ipc';
const INPUT_PATH = path.join(IPC_DIR, 'input.json');
const OUTPUT_PATH = path.join(IPC_DIR, 'output.json');

/**
 * Poll for input.json. Returns null if idle timeout expires.
 */
export async function waitForInput(idleTimeoutMs: number): Promise<ContainerInput | null> {
  const pollInterval = 200;
  const deadline = Date.now() + idleTimeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(INPUT_PATH)) {
      try {
        const raw = fs.readFileSync(INPUT_PATH, 'utf-8');
        const input = JSON.parse(raw) as ContainerInput;
        // Remove input file to signal we've consumed it
        fs.unlinkSync(INPUT_PATH);
        return input;
      } catch {
        // Partially written, retry
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return null; // Idle timeout
}

export function writeOutput(output: ContainerOutput): void {
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
}
