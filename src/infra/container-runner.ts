/**
 * Container worker strategy — how a Docker-sandboxed agent worker starts,
 * stops and reports memory. Pooling, capacity and the request lifecycle are
 * `worker-runner.ts`; this module only decides the docker invocation.
 *
 * Every worker runs `--read-only --cap-drop=ALL --security-opt=no-new-privileges`;
 * only its workspace, IPC dir and the shared browser profile dir are mounted
 * writable, plus extra binds that pass the mount allowlist as read-write. Loopback URLs are rewritten to the host alias. Native MLX
 * credentials remain on the host; each turn receives only a relay capability
 * pinned to its selected model. This is not a general network proxy.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { resolveEffectiveTimezone } from '@hybridclaw/shared/workspace-time';
import {
  CONTAINER_BINDS,
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_MEMORY_SWAP,
  CONTAINER_NETWORK,
} from '../config/config.js';
import { startMlxRelay } from '../inference/mlx-relay.js';
import { logger } from '../logger.js';
import { resolveUploadedMediaCacheHostDir } from '../media/uploaded-media-cache.js';
import { resolveConfiguredAdditionalMounts } from '../security/mount-config.js';
import { validateAdditionalMounts } from '../security/mount-security.js';
import type { AdditionalMount } from '../types/security.js';
import {
  CONTAINER_APP_NODE_MODULES,
  ensureWorkspaceNodeModulesLink,
} from '../workspace.js';
import {
  CONTAINER_BEHAVIOR_ANOMALY_TRAJECTORY_STORE_DIR,
  ensureBehaviorAnomalyTrajectoryStoreDir,
} from './behavior-anomaly-runtime.js';
import {
  containerHostAliasArgs,
  remapHostBaseUrlForContainer,
} from './container-host-alias.js';
import { buildWorkerEnv } from './worker-env.js';
import {
  createWorkerRunner,
  resolveBrowserProfileHostDir,
  resolveDiscordMediaCacheHostDir,
  type WorkerSpawnRequest,
} from './worker-runner.js';

interface ContainerPathAliasMount {
  hostPaths: string[];
  containerPath: string;
  readonly: boolean;
}

const CONTAINER_WORKSPACE_ROOT = '/workspace';
const CONTAINER_DISCORD_MEDIA_CACHE_ROOT = '/discord-media-cache';
const CONTAINER_UPLOADED_MEDIA_CACHE_ROOT = '/uploaded-media-cache';
const CONTAINER_BROWSER_PROFILE_PATH = '/browser-profiles';

function parseMemoryBytes(raw: string): number | null {
  const match = raw.trim().match(/^([\d.]+)\s*([kmgt]?i?b)?/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || 'b').toLowerCase();
  const multiplier =
    unit === 'kb' || unit === 'kib'
      ? 1024
      : unit === 'mb' || unit === 'mib'
        ? 1024 ** 2
        : unit === 'gb' || unit === 'gib'
          ? 1024 ** 3
          : unit === 'tb' || unit === 'tib'
            ? 1024 ** 4
            : 1;
  return Math.floor(value * multiplier);
}

function readContainerMemoryBytes(
  containerNames: string[],
): Promise<Map<string, number>> {
  const memoryByContainer = new Map<string, number>();
  const uniqueContainerNames = Array.from(new Set(containerNames)).filter(
    (name) => name.length > 0,
  );
  if (uniqueContainerNames.length === 0)
    return Promise.resolve(memoryByContainer);

  return new Promise((resolve) => {
    const proc = spawn(
      'docker',
      [
        'stats',
        '--no-stream',
        '--format',
        '{{.Name}}\t{{.MemUsage}}',
        ...uniqueContainerNames,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const separatorIndex = trimmed.indexOf('\t');
        if (separatorIndex === -1) continue;
        const containerName = trimmed.slice(0, separatorIndex).trim();
        const usage = trimmed.slice(separatorIndex + 1).split('/')[0] || '';
        memoryByContainer.set(containerName, parseMemoryBytes(usage) || 0);
      }
      resolve(memoryByContainer);
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

function spawnContainer(spawnRequest: WorkerSpawnRequest) {
  const { request: params, agentId, ipcPath, workspacePath } = spawnRequest;
  const { sessionId, warm = false } = params;
  ensureWorkspaceNodeModulesLink(workspacePath, CONTAINER_APP_NODE_MODULES, {
    allowMissingSource: true,
    replaceExistingSymlink: true,
  });
  const mediaCacheHostPath = resolveDiscordMediaCacheHostDir();
  fs.mkdirSync(mediaCacheHostPath, { recursive: true });
  const uploadedMediaCacheHostPath = resolveUploadedMediaCacheHostDir();
  fs.mkdirSync(uploadedMediaCacheHostPath, { recursive: true });
  const browserProfileHostPath = resolveBrowserProfileHostDir();
  const behaviorAnomalyTrajectoryStoreDir =
    ensureBehaviorAnomalyTrajectoryStoreDir();
  fs.mkdirSync(browserProfileHostPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(browserProfileHostPath, 0o700);
  } catch (err) {
    logger.warn(
      { err, dir: browserProfileHostPath },
      'Failed to set permissions on browser profile directory',
    );
  }
  const containerName = `hybridclaw-${sessionId.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;

  const args = [
    'run',
    '--rm',
    '-i',
    '--name',
    containerName,
    '--memory',
    CONTAINER_MEMORY,
    ...(CONTAINER_MEMORY_SWAP.trim()
      ? ['--memory-swap', CONTAINER_MEMORY_SWAP]
      : []),
    `--cpus=${CONTAINER_CPUS}`,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=256',
    `--network=${CONTAINER_NETWORK || 'bridge'}`,
    ...containerHostAliasArgs(process.platform, CONTAINER_NETWORK || 'bridge'),
    '--tmpfs',
    '/tmp:rw,nosuid,size=512m',
    '-v',
    `${workspacePath}:/workspace:rw`,
    '-v',
    `${ipcPath}:/ipc:rw`,
    '-v',
    `${mediaCacheHostPath}:${CONTAINER_DISCORD_MEDIA_CACHE_ROOT}:ro`,
    '-v',
    `${uploadedMediaCacheHostPath}:${CONTAINER_UPLOADED_MEDIA_CACHE_ROOT}:ro`,
    '-v',
    `${browserProfileHostPath}:${CONTAINER_BROWSER_PROFILE_PATH}:rw`,
    '-v',
    `${behaviorAnomalyTrajectoryStoreDir}:${CONTAINER_BEHAVIOR_ANOMALY_TRAJECTORY_STORE_DIR}:ro`,
    ...Object.entries({
      BROWSER_SHARED_PROFILE_DIR: CONTAINER_BROWSER_PROFILE_PATH,
      HYBRIDCLAW_BEHAVIOR_ANOMALY_TRAJECTORY_STORE_DIR:
        CONTAINER_BEHAVIOR_ANOMALY_TRAJECTORY_STORE_DIR,
      TZ: resolveEffectiveTimezone(),
      HYBRIDCLAW_AGENT_WORKSPACE_ROOT: CONTAINER_WORKSPACE_ROOT,
      ...buildWorkerEnv({
        agentId,
        runtimeScope: params.runtimeScope,
        displayRoot: params.workspaceDisplayRootOverride,
        mode: 'container',
        mapHostUrl: remapHostBaseUrlForContainer,
      }),
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    }).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
  ];

  // Run as host user so bind-mount file ownership matches
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/workspace/.hybridclaw-runtime/home');
  }

  // Validate and append additional mounts
  const configuredMounts = resolveConfiguredAdditionalMounts({
    binds: CONTAINER_BINDS,
  });
  for (const warning of configuredMounts.warnings) {
    logger.warn({ warning }, 'Configured container bind ignored');
  }
  if (configuredMounts.mounts.length > 0) {
    const validated = validateAdditionalMounts(
      configuredMounts.mounts as AdditionalMount[],
    );
    const mountAliases: ContainerPathAliasMount[] = [];
    for (const m of validated) {
      args.push(
        '-v',
        `${m.hostPath}:${m.containerPath}:${m.readonly ? 'ro' : 'rw'}`,
      );
      mountAliases.push({
        hostPaths: Array.from(new Set([m.expandedHostPath, m.hostPath])),
        containerPath: m.containerPath,
        readonly: m.readonly,
      });
    }
    if (mountAliases.length > 0) {
      args.push(
        '-e',
        `HYBRIDCLAW_AGENT_EXTRA_MOUNTS=${JSON.stringify(mountAliases)}`,
      );
    }
  }

  args.push(CONTAINER_IMAGE);

  logger.info(
    { sessionId, ipcSessionId: sessionId, agentId, containerName, warm },
    'Spawning persistent container',
  );
  return {
    process: spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }),
    name: containerName,
  };
}

function stopContainer(containerName: string): void {
  const proc = spawn('docker', ['stop', containerName], { stdio: 'ignore' });
  proc.on('error', (err) => {
    logger.debug({ containerName, err }, 'Failed to stop container');
  });
}

export const containerRunner = createWorkerRunner({
  mode: 'container',
  noun: { one: 'container', many: 'containers' },
  runtimeLabel: 'Container runtime',
  spawnErrorLabel: 'Container spawn error',
  // The sandbox image bakes its own node_modules; the host-side bootstrap
  // script cannot repair it.
  repairHint:
    'The sandbox image is missing this package; rebuild it with `npm run build:container` (or pull a fresh image) and restart the gateway.',
  spawn: spawnContainer,
  stop: (entry) => stopContainer(entry.name || ''),
  memoryKey: (entry) => entry.name || null,
  readMemoryBytes: async (containerNames) => {
    const memoryByContainer = await readContainerMemoryBytes(containerNames);
    let total = 0;
    for (const containerName of containerNames) {
      total += memoryByContainer.get(containerName) || 0;
    }
    return total;
  },
  logFields: (entry) => ({ containerName: entry.name }),
  mapHostUrl: remapHostBaseUrlForContainer,
  stateRoot: (_request, workspacePath) => workspacePath,
  sendsRuntimeEnv: true,
  startModelRelay: ({ input, modelRuntime, ipcPath, model, task }) => {
    if (modelRuntime.provider !== 'mlx') return undefined;
    const relay = startMlxRelay({
      ipcPath,
      baseUrl: modelRuntime.baseUrl,
      apiKey: modelRuntime.apiKey,
      model: model.replace(/^mlx\//, ''),
      task,
    });
    input.baseUrl = 'http://mlx.invalid/v1';
    input.apiKey = '';
    input.requestHeaders = { 'X-HybridClaw-Relay': relay.id };
    return relay;
  },
});
