import readline from 'readline';

import type { ContainerInput, ContainerOutput } from './types.js';

/**
 * Emit a typed NDJSON event to stdout.
 * Used in stdio IPC mode (default).
 */
export function emitStdioEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/**
 * Async generator that reads NDJSON lines from stdin continuously.
 * Used for subsequent requests after the first (which is read via readStdinLine in index.ts).
 */
export async function* readStdinRequests(): AsyncGenerator<ContainerInput> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) {
      yield JSON.parse(trimmed) as ContainerInput;
    }
  }
}

export function writeOutput(output: ContainerOutput): void {
  emitStdioEvent({ type: 'result', status: output.status, result: output.result, toolsUsed: output.toolsUsed, error: output.error });
}
