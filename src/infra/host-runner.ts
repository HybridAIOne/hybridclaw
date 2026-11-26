/**
 * Host worker strategy — how an unsandboxed agent worker process starts on the
 * gateway host, stops and reports memory. Pooling, capacity and the request
 * lifecycle are `worker-runner.ts`; this module only decides the child env.
 *
 * The child gets a sanitized copy of the gateway env, the stored runtime env
 * and the allowed roots its path guard enforces; host mode has no OS-level
 * isolation. Unlike container-runner, a full pool waits for capacity instead
 * of failing at once.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSanitizedEnv } from '@hybridclaw/shared/sensitive-env';
import { CONTAINER_BINDS } from '../config/config.js';
import { readStoredRuntimeEnv } from '../config/runtime-env.js';
import { logger } from '../logger.js';
import { resolveUploadedMediaCacheHostDir } from '../media/uploaded-media-cache.js';
import { resolveConfiguredAdditionalMounts } from '../security/mount-config.js';
import { hostAgentNodePath } from '../skills/skill-node-modules.js';
import { ensureBehaviorAnomalyTrajectoryStoreDir } from './behavior-anomaly-runtime.js';
import { ensureHostRuntimeReady } from './host-runtime-setup.js';
import { hostWorkspaceStateRoot } from './host-workspace.js';
import { resolveInstallRoot } from './install-root.js';
import { buildWorkerEnv } from './worker-env.js';
import {
  createWorkerRunner,
  resolveBrowserProfileHostDir,
  resolveDiscordMediaCacheHostDir,
  type WorkerSpawnRequest,
} from './worker-runner.js';

const HOST_CAPACITY_WAIT_MS = 15_000;
// Nobody watches a background run, so it can queue behind user turns longer.
const BACKGROUND_HOST_CAPACITY_WAIT_MS = 300_000;

function buildHostAllowedRoots(extraRoots: string[] = []): string[] {
  const configured = resolveConfiguredAdditionalMounts({
    binds: CONTAINER_BINDS,
  });
  for (const warning of configured.warnings) {
    logger.warn({ warning }, 'Configured host-mode allowed root ignored');
  }
  return Array.from(
    new Set([
      os.homedir(),
      process.cwd(),
      os.tmpdir(),
      ...extraRoots.map((entry) => path.resolve(entry)),
      ...configured.mounts.map((mount) => path.resolve(mount.hostPath)),
    ]),
  );
}

function resolveHostAgentBrowserBinary(): string | undefined {
  const configured = String(process.env.AGENT_BROWSER_BIN || '').trim();
  if (configured) return configured;

  const installRoot = resolveInstallRoot();
  const binName =
    process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser';
  const candidates = [
    path.join(installRoot, 'container', 'node_modules', '.bin', binName),
    path.join(installRoot, 'node_modules', '.bin', binName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function ensureWorkspaceNodeModulesLink(workspacePath: string): void {
  const packageRoot = resolveInstallRoot();
  const sourceNodeModules = path.join(packageRoot, 'node_modules');
  if (!fs.existsSync(sourceNodeModules)) return;

  const targetNodeModules = path.join(workspacePath, 'node_modules');

  try {
    const stat = fs.lstatSync(targetNodeModules);
    if (stat.isSymbolicLink()) {
      const existingTarget = fs.readlinkSync(targetNodeModules);
      const resolvedExisting = path.resolve(
        path.dirname(targetNodeModules),
        existingTarget,
      );
      if (resolvedExisting === sourceNodeModules) return;
    }
    fs.rmSync(targetNodeModules, { recursive: true, force: true });
  } catch {
    // Missing target is fine; we'll create it below.
  }

  fs.symlinkSync(sourceNodeModules, targetNodeModules, 'dir');
}

async function readProcessRssBytes(pid: number | undefined): Promise<number> {
  if (!pid) return 0;
  if (process.platform === 'linux') {
    const status = await fs.promises
      .readFile(`/proc/${pid}/status`, 'utf-8')
      .catch(() => '');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    const rssKb = match ? Number(match[1]) : 0;
    return Number.isFinite(rssKb) ? Math.max(0, Math.floor(rssKb * 1024)) : 0;
  }

  return new Promise((resolve) => {
    const proc = spawn('ps', ['-o', 'rss=', '-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const rssKb = Number(stdout.trim());
      resolve(
        Number.isFinite(rssKb) ? Math.max(0, Math.floor(rssKb * 1024)) : 0,
      );
    };
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      finish();
    }, 2_000);
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    proc.on('error', finish);
    proc.on('close', finish);
  });
}

function spawnHostProcess(spawnRequest: WorkerSpawnRequest) {
  const { request: params, agentId, ipcPath, workspacePath } = spawnRequest;
  const { sessionId, warm = false } = params;
  const stateRoot = hostWorkspaceStateRoot(params);
  fs.mkdirSync(stateRoot, { recursive: true });
  ensureWorkspaceNodeModulesLink(stateRoot);
  const mediaCacheHostPath = resolveDiscordMediaCacheHostDir();
  const uploadedMediaCacheHostPath = resolveUploadedMediaCacheHostDir();
  fs.mkdirSync(mediaCacheHostPath, { recursive: true });
  fs.mkdirSync(uploadedMediaCacheHostPath, { recursive: true });

  const runtime = ensureHostRuntimeReady({
    commandName: 'hybridclaw',
    required: true,
  });
  if (!runtime) {
    throw new Error('Host runtime unexpectedly unavailable.');
  }
  const agentBrowserBin = resolveHostAgentBrowserBinary();
  const storedRuntimeEnv = readStoredRuntimeEnv();
  const env: NodeJS.ProcessEnv = {
    ...buildSanitizedEnv(process.env),
    ...storedRuntimeEnv,
    ...buildWorkerEnv({
      agentId,
      runtimeScope: params.runtimeScope,
      displayRoot: params.workspaceDisplayRootOverride,
      mode: 'host',
      mapHostUrl: (url) => url,
    }),
    NODE_PATH: hostAgentNodePath(
      storedRuntimeEnv.NODE_PATH || process.env.NODE_PATH,
    ),
    HYBRIDCLAW_BEHAVIOR_ANOMALY_TRAJECTORY_STORE_DIR:
      ensureBehaviorAnomalyTrajectoryStoreDir(),
    HYBRIDCLAW_AGENT_WORKSPACE_ROOT: workspacePath,
    HYBRIDCLAW_AGENT_STATE_ROOT: stateRoot,
    HYBRIDCLAW_AGENT_ALLOWED_ROOTS: JSON.stringify(
      buildHostAllowedRoots([workspacePath, stateRoot]),
    ),
    HYBRIDCLAW_AGENT_MEDIA_ROOT: mediaCacheHostPath,
    HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT: uploadedMediaCacheHostPath,
    HYBRIDCLAW_AGENT_IPC_DIR: ipcPath,
    BROWSER_SHARED_PROFILE_DIR: resolveBrowserProfileHostDir(),
    AGENT_BROWSER_BIN: agentBrowserBin,
  };
  if (params.bashProxy?.mode === 'docker-exec') {
    env.HYBRIDCLAW_BASH_DOCKER_CONTAINER = params.bashProxy.containerName;
    env.HYBRIDCLAW_BASH_DOCKER_CWD = params.bashProxy.cwd || '/app';
  }

  logger.info(
    {
      sessionId,
      ipcSessionId: sessionId,
      agentId,
      command: runtime.command,
      args: runtime.args,
      warm,
    },
    'Spawning host agent process',
  );
  return {
    process: spawn(runtime.command, runtime.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workspacePath,
      env,
    }),
  };
}

export const hostRunner = createWorkerRunner({
  mode: 'host',
  noun: { one: 'host agent process', many: 'host agent processes' },
  runtimeLabel: 'Host agent process',
  spawnErrorLabel: 'Host agent spawn error',
  spawn: spawnHostProcess,
  stop: (entry) => {
    try {
      entry.process.kill('SIGTERM');
    } catch (err) {
      logger.debug(
        { sessionId: entry.sessionId, err },
        'Failed to stop host agent',
      );
    }
  },
  dropsEntryOnAbort: false,
  guardsStdinErrors: true,
  memoryKey: (entry) =>
    typeof entry.process.pid === 'number' ? String(entry.process.pid) : null,
  readMemoryBytes: async (pids) => {
    const rssValues = await Promise.all(
      pids.map((pid) => readProcessRssBytes(Number(pid))),
    );
    return rssValues.reduce((sum, rssBytes) => sum + rssBytes, 0);
  },
  logFields: () => ({}),
  mapHostUrl: (url) => url,
  stateRoot: (request) => hostWorkspaceStateRoot(request),
  sendsRuntimeEnv: false,
  capacityWaitMs: (background) =>
    background ? BACKGROUND_HOST_CAPACITY_WAIT_MS : HOST_CAPACITY_WAIT_MS,
});
