/**
 * Executor selection applies a run override before the configured sandbox mode.
 * Unlike the runners, this module owns selection and the cross-mode totals;
 * selecting an executor never starts a worker or grants workspace access.
 */
import {
  CONTAINER_BINDS,
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_MEMORY_SWAP,
  CONTAINER_NETWORK,
  CONTAINER_SANDBOX_MODE,
  getSandboxAutoDetectionState,
  MOUNT_ALLOWLIST_PATH,
} from '../config/config.js';
import { containerRunner } from '../infra/container-runner.js';
import { hostRunner } from '../infra/host-runner.js';
import { parseBindSpecs } from '../security/mount-config.js';
import type {
  Executor,
  ExecutorSessionHealthSnapshot,
} from './executor-types.js';

export interface SandboxDiagnostics {
  mode: 'container' | 'host';
  modeExplicit: boolean;
  runningInsideContainer: boolean;
  image: string | null;
  network: string | null;
  memory: string | null;
  memorySwap: string | null;
  cpus: string | null;
  securityFlags: string[];
  mountAllowlistPath: string;
  additionalMountsConfigured: number;
  activeSessions: number;
  activeSessionIds: string[];
  warning: string | null;
}

const EXECUTORS: Executor[] = [containerRunner, hostRunner];

export function resolveExecutorMode(
  override?: 'host' | 'container',
): 'host' | 'container' {
  return override || CONTAINER_SANDBOX_MODE;
}

export function getExecutor(override?: 'host' | 'container'): Executor {
  return resolveExecutorMode(override) === 'host'
    ? hostRunner
    : containerRunner;
}

function parseAdditionalMountsCount(): number {
  return parseBindSpecs(CONTAINER_BINDS).mounts.length;
}

export function getActiveExecutorCount(): number {
  return EXECUTORS.reduce(
    (sum, executor) => sum + executor.getActiveSessionCount(),
    0,
  );
}

export function getInFlightExecutorCount(): number {
  return EXECUTORS.reduce(
    (sum, executor) => sum + executor.getInFlightSessionCount(),
    0,
  );
}

function sortedUnique(ids: string[]): string[] {
  return Array.from(new Set(ids)).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function getActiveExecutorSessionIds(): string[] {
  return sortedUnique(
    EXECUTORS.flatMap((executor) => executor.getActiveSessionIds()),
  );
}

/** Sessions with a turn executing right now, not merely a warm worker. */
export function getInFlightExecutorSessionIds(): string[] {
  return sortedUnique(
    EXECUTORS.flatMap((executor) => executor.getInFlightSessionIds()),
  );
}

export async function getExecutorSessionHealthSnapshots(): Promise<
  ExecutorSessionHealthSnapshot[]
> {
  const snapshots = await Promise.all(
    EXECUTORS.map((executor) => executor.getSessionHealthSnapshots()),
  );
  return snapshots
    .flat()
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

export function stopSessionExecution(sessionId: string): boolean {
  let stopped = false;
  for (const executor of EXECUTORS) {
    stopped = executor.stopSession(sessionId) || stopped;
  }
  return stopped;
}

export function stopAllExecutions(): void {
  for (const executor of EXECUTORS) executor.stopAll();
}

export function getSandboxDiagnostics(): SandboxDiagnostics {
  const autoDetection = getSandboxAutoDetectionState();
  const mode = CONTAINER_SANDBOX_MODE;
  const securityFlags =
    mode === 'container'
      ? [
          'read-only rootfs',
          'tmpfs /tmp:rw,nosuid,size=512m',
          'cap-drop=ALL',
          'security-opt=no-new-privileges',
          'pids-limit=256',
          `network=${CONTAINER_NETWORK}`,
        ]
      : ['workspace fencing', 'command deny-list', 'secret env scrubbing'];

  return {
    mode,
    modeExplicit: autoDetection.sandboxModeExplicit,
    runningInsideContainer: autoDetection.runningInsideContainer,
    image: mode === 'container' ? CONTAINER_IMAGE : null,
    network: mode === 'container' ? CONTAINER_NETWORK : null,
    memory: mode === 'container' ? CONTAINER_MEMORY : null,
    memorySwap: mode === 'container' ? CONTAINER_MEMORY_SWAP || null : null,
    cpus: mode === 'container' ? CONTAINER_CPUS : null,
    securityFlags,
    mountAllowlistPath: MOUNT_ALLOWLIST_PATH,
    additionalMountsConfigured: parseAdditionalMountsCount(),
    activeSessions: getActiveExecutorCount(),
    activeSessionIds: getActiveExecutorSessionIds(),
    warning:
      mode === 'host'
        ? 'Running in host mode without container isolation.'
        : null,
  };
}
