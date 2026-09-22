/**
 * Native MLX process ownership. A foreground owner stops only its own child;
 * credentials and installation state remain local to the configured home.
 * This is lifecycle management, not automatic model or cloud fallback.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import {
  detectMacHardware,
  estimateMacModelCacheBytes,
  estimateMacModels,
  GIB,
  MAC_MODEL_CATALOG,
} from './local-model-catalog.js';
import { assertMlxEndpoint } from './mlx-endpoint.js';
import { MlxOperationError } from './mlx-operation-error.js';

export interface MlxInstallation {
  version: 1;
  model: string;
  repo: string;
  revision: string;
  license: string;
  port: number;
  contextWindow: number;
  memoryLimitBytes: number;
  cacheBytes: number;
}
export const MLX_COMPONENT = fileURLToPath(
  new URL('../../inference/mlx/', import.meta.url),
);
export function mlxHome(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, 'inference', 'mlx');
}
export function readMlxInstallation(home = mlxHome()): MlxInstallation {
  const value = JSON.parse(
    fs.readFileSync(path.join(home, 'installation.json'), 'utf8'),
  ) as MlxInstallation;
  if (
    value.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(value.revision) ||
    typeof value.model !== 'string' ||
    typeof value.repo !== 'string' ||
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535 ||
    !Number.isInteger(value.contextWindow) ||
    value.contextWindow < 2048 ||
    value.contextWindow > 40960 ||
    !Number.isSafeInteger(value.memoryLimitBytes) ||
    value.memoryLimitBytes <= 0 ||
    !Number.isSafeInteger(value.cacheBytes) ||
    value.cacheBytes <= 0 ||
    value.cacheBytes > value.memoryLimitBytes
  ) {
    throw new Error('Invalid MLX installation; run hybridclaw local setup.');
  }
  return value;
}
export function mlxCredentials(home = mlxHome()) {
  const installation = readMlxInstallation(home);
  const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid MLX credential.');
  const baseUrl = `http://127.0.0.1:${installation.port}/v1`;
  assertMlxEndpoint(baseUrl);
  return { installation, token, baseUrl };
}
export async function mlxHealth(
  home = mlxHome(),
): Promise<Record<string, unknown> | null> {
  const { token, baseUrl, installation } = mlxCredentials(home);
  try {
    const response = await fetch(`${baseUrl.slice(0, -3)}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const health = (await response.json()) as Record<string, unknown>;
    return health.revision === installation.revision &&
      health.model === installation.model
      ? health
      : null;
  } catch {
    return null;
  }
}
export async function stopMlxChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (
    let n = 0;
    n < 50 && child.exitCode === null && child.signalCode === null;
    n++
  )
    await delay(100);
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
}
export async function startMlxChild(
  home = mlxHome(),
  signal?: AbortSignal,
): Promise<ChildProcess> {
  const installation = readMlxInstallation(home);
  const model = MAC_MODEL_CATALOG.find(
    (candidate) =>
      candidate.id === installation.model &&
      candidate.repo === installation.repo &&
      candidate.revision === installation.revision,
  );
  if (!model) throw new MlxOperationError('artifact');
  if (installation.contextWindow > model.maxContextWindow)
    throw new MlxOperationError('context');
  const hardware = detectMacHardware();
  const capacity = estimateMacModels(hardware);
  if (!capacity.supported) throw new MlxOperationError('platform');
  if (
    model.weightBytes * 1.1 +
      GIB +
      estimateMacModelCacheBytes(model, installation.contextWindow) +
      installation.cacheBytes >
    Math.min(capacity.memoryLimitBytes, installation.memoryLimitBytes)
  ) {
    throw new MlxOperationError('memory');
  }
  if (await mlxHealth(home)) throw new MlxOperationError('running');
  const child = spawn(
    path.join(home, 'venv', 'bin', 'python'),
    [path.join(MLX_COMPONENT, 'server.py'), home],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        TMPDIR: process.env.TMPDIR,
        PYTHONNOUSERSITE: '1',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
      },
    },
  );
  const abort = () => {
    void stopMlxChild(child);
  };
  signal?.addEventListener('abort', abort, { once: true });
  child.once('exit', () => signal?.removeEventListener('abort', abort));
  if (signal?.aborted) abort();
  let failed = false;
  child.on('error', () => {
    failed = true;
  });
  // Drain output without persisting payload-bearing library diagnostics.
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    for (let n = 0; n < 600; n++) {
      if (signal?.aborted) throw new Error('MLX startup cancelled.');
      if (failed || child.exitCode !== null || child.signalCode !== null)
        throw new MlxOperationError('startup');
      if (await mlxHealth(home)) return child;
      await delay(500);
    }
    throw new MlxOperationError('timeout');
  } catch (error) {
    await stopMlxChild(child);
    throw error;
  }
}
