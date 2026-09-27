/**
 * One request through the real container agent runtime: spawns
 * `container/src/index.ts`, writes `input` to its stdin, and returns the IPC
 * output it writes. Model calls go wherever `input.baseUrl` points, so suites
 * pair it with a local fake model server.
 *
 * Single-shot: the worker is stopped after its first output. Suites that feed
 * follow-up inputs to one live worker keep their own harness.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  ContainerInput,
  ContainerOutput,
} from '../../src/types/container.js';

export async function runContainerWorker(
  input: ContainerInput,
  env: Record<string, string>,
): Promise<ContainerOutput> {
  const ipcDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-worker-ipc-'),
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'container/src/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HYBRIDCLAW_AGENT_IPC_DIR: ipcDir,
        HYBRIDCLAW_RETRY_ENABLED: 'false',
        CONTAINER_IDLE_TIMEOUT: '25',
        ...env,
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  try {
    const outputPath = path.join(ipcDir, 'output.json');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      // Missing and unparseable both mean not ready yet, as in readOutput
      // (src/infra/ipc.ts).
      try {
        return JSON.parse(
          fs.readFileSync(outputPath, 'utf8'),
        ) as ContainerOutput;
      } catch {}
      if (child.exitCode !== null) break;
      await delay(25);
    }
    throw new Error(`Worker produced no IPC output: ${stderr}`);
  } finally {
    child.kill('SIGTERM');
    await exited;
    fs.rmSync(ipcDir, { recursive: true, force: true });
  }
}
