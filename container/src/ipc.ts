import fs from 'node:fs';
import path from 'node:path';

import { IPC_DIR } from './runtime-paths.js';
import type { QueuedSteeringNote } from './steering.js';
import type { ContainerInput, ContainerOutput } from './types.js';

const INPUT_PATH = path.join(IPC_DIR, 'input.json');
const OUTPUT_PATH = path.join(IPC_DIR, 'output.json');

/**
 * Poll for input.json. Returns null if idle timeout expires.
 */
export async function waitForInput(
  idleTimeoutMs: number,
): Promise<ContainerInput | null> {
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

export function takePendingSteeringNotes(): QueuedSteeringNote[] {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(IPC_DIR)
      .filter((entry) => entry.startsWith('steer-') && entry.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }

  const notes: QueuedSteeringNote[] = [];
  for (const entry of entries) {
    const filePath = path.join(IPC_DIR, entry);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<QueuedSteeringNote>;
      const note = String(parsed.note || '').trim();
      const createdAt = String(parsed.createdAt || '').trim();
      if (note && createdAt) {
        notes.push({ note, createdAt });
      }
    } catch {
      // Ignore malformed steering payloads after removing them below.
    } finally {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }
  }

  return notes;
}
