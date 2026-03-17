import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gatewayHealth } from '../gateway/gateway-client.js';
import {
  isPidRunning,
  readGatewayPid,
  removeGatewayPidFile,
} from '../gateway/gateway-lifecycle.js';
import { resolveInstallRoot } from '../infra/install-root.js';
import { sleep } from '../utils/sleep.js';

function resolveGatewayCommand(): { command: string; args: string[] } {
  const installRoot = resolveInstallRoot();
  const distCli = path.join(installRoot, 'dist', 'cli.js');
  if (fs.existsSync(distCli)) {
    return {
      command: process.execPath,
      args: [distCli, 'gateway'],
    };
  }

  return {
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      path.join(installRoot, 'src', 'cli.ts'),
      'gateway',
    ],
  };
}

async function stopRunningGatewayPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return;
    throw error;
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return;
    await sleep(200);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ESRCH') throw error;
  }
}

async function waitForGatewayHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await gatewayHealth();
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Gateway did not become healthy after restart.');
}

export async function restartGatewayFromDoctor(): Promise<void> {
  const pidState = readGatewayPid();
  if (pidState && isPidRunning(pidState.pid)) {
    await stopRunningGatewayPid(pidState.pid);
  }
  removeGatewayPidFile();

  const { command, args } = resolveGatewayCommand();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: 'utf-8',
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Gateway restart failed with exit code ${result.status}.`,
    );
  }

  await waitForGatewayHealthy(20_000);
}
