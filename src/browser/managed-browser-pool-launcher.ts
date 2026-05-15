import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config/config.js';
import {
  getRuntimeConfig,
  type RuntimeManagedCloudBrowserConfig,
} from '../config/runtime-config.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { logger } from '../logger.js';
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

let poolProcess: ChildProcess | null = null;
let poolLogTail = '';

function appendLogTail(chunk: Buffer | string): void {
  poolLogTail += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
  const bytes = Buffer.byteLength(poolLogTail, 'utf-8');
  if (bytes <= LOG_TAIL_LIMIT_BYTES) return;
  poolLogTail = poolLogTail.slice(-LOG_TAIL_LIMIT_BYTES);
}

function isProcessAlive(child: ChildProcess | null): child is ChildProcess {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
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

function resolvePolicyPath(dataRoot: string): string {
  const operatorPolicyPath = path.join(dataRoot, 'tenants.yaml');
  if (fs.existsSync(operatorPolicyPath)) return operatorPolicyPath;
  return resolveInstallPath('infra', 'managed-browser', 'tenants.example.yaml');
}

function resolvePoolToken(
  config: RuntimeManagedCloudBrowserConfig,
): string | undefined {
  if (!config.poolTokenRef) return undefined;
  return resolveSecretInputUnsafe(config.poolTokenRef, {
    path: 'browser.managedCloud.poolTokenRef',
    required: true,
    reason: 'launch managed browser pool child process environment',
    audit: noopSecretAudit,
  });
}

export function buildManagedBrowserPoolLaunchSpec(
  config: RuntimeManagedCloudBrowserConfig,
  options: {
    dataDir?: string;
    installRoot?: string;
  } = {},
): ManagedBrowserPoolLaunchSpec {
  const endpointUrl = normalizeManagedCloudEndpointUrl(config.endpointUrl);
  const parsed = new URL(endpointUrl);
  if (parsed.protocol !== 'http:') {
    throw new Error(
      'Local managed browser pool launch only supports http:// loopback endpoints.',
    );
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'Local managed browser pool launch is only available for loopback endpoints.',
    );
  }

  const installRoot = options.installRoot || resolveInstallPath();
  const managedBrowserRoot = path.join(installRoot, 'infra', 'managed-browser');
  const serverPath = path.join(managedBrowserRoot, 'server.js');
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Managed browser pool server is missing: ${serverPath}`);
  }

  const dataRoot = path.join(options.dataDir || DATA_DIR, 'managed-browser');
  const poolToken = resolvePoolToken(config);
  return {
    command: process.execPath,
    args: [serverPath],
    cwd: managedBrowserRoot,
    endpointUrl,
    env: {
      ...process.env,
      MANAGED_BROWSER_BIND_HOST: resolveBindHost(parsed.hostname),
      MANAGED_BROWSER_PORT: String(resolveEndpointPort(parsed)),
      MANAGED_BROWSER_NODE_ID: 'gateway-managed-browser-node-1',
      MANAGED_BROWSER_STATE_PATH: path.join(dataRoot, 'leases.json'),
      MANAGED_BROWSER_AUDIT_PATH: path.join(dataRoot, 'audit.jsonl'),
      MANAGED_BROWSER_POLICY_PATH: resolvePolicyPath(dataRoot),
      ...(poolToken ? { MANAGED_BROWSER_POOL_TOKEN: poolToken } : {}),
    },
  };
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
    if (!isProcessAlive(poolProcess)) break;
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

  const currentHealth = await checkManagedBrowserPoolHealth(endpointUrl);
  if (currentHealth.ok) {
    return {
      ok: true,
      status: 'already-running',
      endpointUrl: currentHealth.endpointUrl,
      pid: isProcessAlive(poolProcess) ? (poolProcess.pid ?? null) : null,
      message: currentHealth.message,
    };
  }

  if (isProcessAlive(poolProcess)) {
    return {
      ok: true,
      status: 'starting',
      endpointUrl,
      pid: poolProcess.pid ?? null,
      message: currentHealth.message,
      logTail: poolLogTail || undefined,
    };
  }

  let spec: ManagedBrowserPoolLaunchSpec;
  try {
    spec = buildManagedBrowserPoolLaunchSpec(browserConfig.managedCloud);
  } catch (error) {
    return {
      ok: false,
      status: 'unsupported',
      endpointUrl,
      pid: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const statePath = spec.env.MANAGED_BROWSER_STATE_PATH;
  if (!statePath) {
    return {
      ok: false,
      status: 'failed',
      endpointUrl: spec.endpointUrl,
      pid: null,
      message: 'Managed browser pool state path was not configured.',
    };
  }
  fs.mkdirSync(path.dirname(statePath), {
    recursive: true,
  });
  poolLogTail = '';
  poolProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  poolProcess.stdout?.on('data', appendLogTail);
  poolProcess.stderr?.on('data', appendLogTail);
  poolProcess.once('exit', (exitCode, signal) => {
    logger.warn(
      {
        exitCode,
        signal,
        endpointUrl: spec.endpointUrl,
        logTail: poolLogTail || undefined,
      },
      'Managed browser pool process exited',
    );
    poolProcess = null;
  });
  poolProcess.once('error', (error) => {
    logger.error(
      { error, endpointUrl: spec.endpointUrl },
      'Managed browser pool process failed',
    );
    poolProcess = null;
  });

  logger.info(
    {
      pid: poolProcess.pid,
      endpointUrl: spec.endpointUrl,
      cwd: spec.cwd,
      command: spec.command,
      args: spec.args,
      policyPath: spec.env.MANAGED_BROWSER_POLICY_PATH,
      statePath: spec.env.MANAGED_BROWSER_STATE_PATH,
    },
    'Started managed browser pool process from admin backend',
  );

  const health = await waitForPoolHealth(spec.endpointUrl);
  if (health.ok) {
    return {
      ok: true,
      status: 'started',
      endpointUrl: spec.endpointUrl,
      pid: poolProcess?.pid ?? null,
      message: health.message,
      logTail: poolLogTail || undefined,
    };
  }

  return {
    ok: isProcessAlive(poolProcess),
    status: isProcessAlive(poolProcess) ? 'starting' : 'failed',
    endpointUrl: spec.endpointUrl,
    pid: poolProcess?.pid ?? null,
    message: health.message,
    logTail: poolLogTail || undefined,
  };
}
