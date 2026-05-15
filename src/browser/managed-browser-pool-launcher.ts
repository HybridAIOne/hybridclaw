import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  getRuntimeConfig,
  type RuntimeManagedCloudBrowserConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { logger } from '../logger.js';
import {
  readStoredRuntimeSecret,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { resolveSecretInputUnsafe } from '../security/secret-refs.js';
import { checkManagedBrowserPoolHealth } from './managed-cloud-doctor.js';
import { normalizeManagedCloudEndpointUrl } from './managed-cloud-provider.js';
import { noopSecretAudit } from './playwright-utils.js';

export type ManagedBrowserPoolLaunchStatus =
  | 'started'
  | 'starting'
  | 'already-running'
  | 'unsupported'
  | 'failed';

export interface ManagedBrowserPoolLaunchResult {
  ok: boolean;
  status: ManagedBrowserPoolLaunchStatus;
  endpointUrl: string;
  pid: number | null;
  message: string;
  poolTokenRefId?: string;
  logTail?: string;
}

export interface ManagedBrowserPoolLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  endpointUrl: string;
  env: NodeJS.ProcessEnv;
}

const LOG_TAIL_LIMIT_BYTES = 16 * 1024;
const HEALTH_WAIT_TIMEOUT_MS = 5_000;
const HEALTH_WAIT_INTERVAL_MS = 250;
const COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_POOL_TOKEN_REF_ID = 'MANAGED_BROWSER_POOL_TOKEN';

let poolLogTail = '';

function appendLogTail(chunk: Buffer | string): void {
  poolLogTail += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
  const bytes = Buffer.byteLength(poolLogTail, 'utf-8');
  if (bytes <= LOG_TAIL_LIMIT_BYTES) return;
  poolLogTail = poolLogTail.slice(-LOG_TAIL_LIMIT_BYTES);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized === '::1'
  );
}

function resolveBindHost(hostname: string): string {
  if (hostname.toLowerCase() === 'localhost') return '127.0.0.1';
  return hostname.replace(/^\[(.*)\]$/u, '$1');
}

function resolveEndpointPort(url: URL): number {
  const rawPort = url.port.trim();
  if (!rawPort) {
    throw new Error(
      'Local managed browser pool launch requires an explicit endpoint port.',
    );
  }
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid managed browser pool endpoint port: ${rawPort}`);
  }
  return port;
}

function assertLocalDockerEndpoint(endpointUrl: string): void {
  const parsed = new URL(endpointUrl);
  if (parsed.protocol !== 'http:') {
    throw new Error(
      'Local Docker browser pool launch only supports http:// loopback endpoints.',
    );
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'Local Docker browser pool launch is only available for loopback endpoints.',
    );
  }
  resolveEndpointPort(parsed);
}

function resolvePoolToken(
  config: RuntimeManagedCloudBrowserConfig,
  fallback?: string,
): string {
  if (fallback) return fallback;
  if (!config.poolTokenRef) {
    throw new Error(
      'Local Docker browser pool launch requires browser.managedCloud.poolTokenRef.',
    );
  }
  return (
    resolveSecretInputUnsafe(config.poolTokenRef, {
      path: 'browser.managedCloud.poolTokenRef',
      required: true,
      reason: 'launch managed browser pool Docker Compose environment',
      audit: noopSecretAudit,
    }) || ''
  );
}

function ensurePoolTokenRef(
  config: RuntimeManagedCloudBrowserConfig,
): RuntimeManagedCloudBrowserConfig {
  if (config.poolTokenRef) return config;

  if (!readStoredRuntimeSecret(DEFAULT_POOL_TOKEN_REF_ID)) {
    saveNamedRuntimeSecrets({
      [DEFAULT_POOL_TOKEN_REF_ID]: randomBytes(32).toString('base64url'),
    });
  }

  const saved = updateRuntimeConfig((draft) => {
    draft.browser.managedCloud.poolTokenRef = {
      source: 'store',
      id: DEFAULT_POOL_TOKEN_REF_ID,
    };
  });
  return saved.browser.managedCloud;
}

export function buildManagedBrowserPoolLaunchSpec(
  config: RuntimeManagedCloudBrowserConfig,
  options: {
    installRoot?: string;
    poolToken?: string;
  } = {},
): ManagedBrowserPoolLaunchSpec {
  const endpointUrl = normalizeManagedCloudEndpointUrl(config.endpointUrl);
  const parsed = new URL(endpointUrl);
  assertLocalDockerEndpoint(endpointUrl);

  const installRoot = options.installRoot || resolveInstallPath();
  const composePath = path.join(
    installRoot,
    'infra',
    'managed-browser',
    'docker-compose.yml',
  );
  if (!fs.existsSync(composePath)) {
    throw new Error(
      `Managed browser pool Compose file is missing: ${composePath}`,
    );
  }

  const poolToken = resolvePoolToken(config, options.poolToken);
  return {
    command: 'docker',
    args: [
      'compose',
      '-f',
      path.relative(installRoot, composePath),
      'up',
      '-d',
      '--build',
      'browser-pool',
    ],
    cwd: installRoot,
    endpointUrl,
    env: {
      ...process.env,
      MANAGED_BROWSER_PUBLISH_HOST: resolveBindHost(parsed.hostname),
      MANAGED_BROWSER_PORT: String(resolveEndpointPort(parsed)),
      MANAGED_BROWSER_POOL_TOKEN: poolToken,
    },
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    const onOutput = (chunk: Buffer | string) => {
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, signal, output });
    });
  });
}

async function assertDockerReady(): Promise<void> {
  try {
    const info = await runCommand('docker', ['info'], {
      timeoutMs: 15_000,
    });
    if (info.exitCode !== 0) {
      throw new Error(info.output.trim() || 'docker info failed');
    }
    const compose = await runCommand('docker', ['compose', 'version'], {
      timeoutMs: 15_000,
    });
    if (compose.exitCode !== 0) {
      throw new Error(compose.output.trim() || 'docker compose version failed');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker is not ready to launch the browser pool: ${message}`,
    );
  }
}

async function waitForPoolHealth(
  endpointUrl: string,
): Promise<{ ok: boolean; message: string }> {
  const deadline = Date.now() + HEALTH_WAIT_TIMEOUT_MS;
  let message = 'Managed browser pool health check did not complete.';
  while (Date.now() < deadline) {
    const health = await checkManagedBrowserPoolHealth(endpointUrl);
    message = health.message;
    if (health.ok) return { ok: true, message };
    await sleep(HEALTH_WAIT_INTERVAL_MS);
  }
  return { ok: false, message };
}

export async function startLocalManagedBrowserPool(): Promise<ManagedBrowserPoolLaunchResult> {
  const browserConfig = getRuntimeConfig().browser;
  const endpointUrl = normalizeManagedCloudEndpointUrl(
    browserConfig.managedCloud.endpointUrl,
  );
  if (browserConfig.provider !== 'managed-cloud') {
    return {
      ok: false,
      status: 'unsupported',
      endpointUrl,
      pid: null,
      message: 'Browser provider is not managed-cloud.',
    };
  }

  let managedCloudConfig: RuntimeManagedCloudBrowserConfig;
  try {
    assertLocalDockerEndpoint(endpointUrl);
    managedCloudConfig = ensurePoolTokenRef(browserConfig.managedCloud);
  } catch (error) {
    return {
      ok: false,
      status: 'unsupported',
      endpointUrl,
      pid: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const poolTokenRefId = managedCloudConfig.poolTokenRef?.id;

  const currentHealth = await checkManagedBrowserPoolHealth(endpointUrl);
  if (currentHealth.ok) {
    return {
      ok: true,
      status: 'already-running',
      endpointUrl: currentHealth.endpointUrl,
      pid: null,
      message: currentHealth.message,
      ...(poolTokenRefId ? { poolTokenRefId } : {}),
    };
  }

  let spec: ManagedBrowserPoolLaunchSpec;
  try {
    spec = buildManagedBrowserPoolLaunchSpec(managedCloudConfig);
  } catch (error) {
    return {
      ok: false,
      status: 'unsupported',
      endpointUrl,
      pid: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    await assertDockerReady();
  } catch (error) {
    return {
      ok: false,
      status: 'unsupported',
      endpointUrl: spec.endpointUrl,
      pid: null,
      message: error instanceof Error ? error.message : String(error),
      ...(poolTokenRefId ? { poolTokenRefId } : {}),
    };
  }

  poolLogTail = '';
  let composeResult: Awaited<ReturnType<typeof runCommand>>;
  try {
    composeResult = await runCommand(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
    });
    appendLogTail(composeResult.output);
  } catch (error) {
    logger.error(
      { error, endpointUrl: spec.endpointUrl },
      'Managed browser pool Docker Compose launch failed',
    );
    return {
      ok: false,
      status: 'failed',
      endpointUrl: spec.endpointUrl,
      pid: null,
      message: error instanceof Error ? error.message : String(error),
      ...(poolTokenRefId ? { poolTokenRefId } : {}),
      logTail: poolLogTail || undefined,
    };
  }

  if (composeResult.exitCode !== 0) {
    return {
      ok: false,
      status: 'failed',
      endpointUrl: spec.endpointUrl,
      pid: null,
      message: `Docker Compose exited with code ${composeResult.exitCode}.`,
      ...(poolTokenRefId ? { poolTokenRefId } : {}),
      logTail: poolLogTail || undefined,
    };
  }

  logger.info(
    {
      endpointUrl: spec.endpointUrl,
      cwd: spec.cwd,
      command: spec.command,
      args: spec.args,
    },
    'Started managed browser pool Docker Compose service from admin backend',
  );

  const health = await waitForPoolHealth(spec.endpointUrl);
  if (health.ok) {
    return {
      ok: true,
      status: 'started',
      endpointUrl: spec.endpointUrl,
      pid: null,
      message: health.message,
      ...(poolTokenRefId ? { poolTokenRefId } : {}),
      logTail: poolLogTail || undefined,
    };
  }

  return {
    ok: false,
    status: 'failed',
    endpointUrl: spec.endpointUrl,
    pid: null,
    message: health.message,
    ...(poolTokenRefId ? { poolTokenRefId } : {}),
    logTail: poolLogTail || undefined,
  };
}
