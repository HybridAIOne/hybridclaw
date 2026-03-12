import {
  ADDITIONAL_MOUNTS,
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
import { ContainerExecutor } from '../infra/container-runner.js';
import { HostExecutor } from '../infra/host-runner.js';
import {
  parseBindSpecs,
  parseLegacyAdditionalMounts,
} from '../security/mount-config.js';
import type {
  ChatMessage,
  ContainerOutput,
  MediaContextItem,
  ScheduledTask,
  ToolProgressEvent,
} from '../types.js';

export interface ExecutorRequest {
  sessionId: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  model?: string;
  agentId?: string;
  channelId?: string;
  ralphMaxIterations?: number | null;
  fullAutoEnabled?: boolean;
  fullAutoNeverApproveTools?: string[];
  scheduledTasks?: ScheduledTask[];
  allowedTools?: string[];
  blockedTools?: string[];
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  abortSignal?: AbortSignal;
  media?: MediaContextItem[];
}

export interface Executor {
  exec(request: ExecutorRequest): Promise<ContainerOutput>;
  getWorkspacePath(agentId: string): string;
  stopSession(sessionId: string): boolean;
  stopAll(): void;
  getActiveSessionCount(): number;
  getActiveSessionIds(): string[];
}

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
  warning: string | null;
}

let containerExecutor: ContainerExecutor | null = null;
let hostExecutor: HostExecutor | null = null;

function getContainerExecutor(): ContainerExecutor {
  containerExecutor ??= new ContainerExecutor();
  return containerExecutor;
}

function getHostExecutor(): HostExecutor {
  hostExecutor ??= new HostExecutor();
  return hostExecutor;
}

export function getExecutor(): Executor {
  return CONTAINER_SANDBOX_MODE === 'host'
    ? getHostExecutor()
    : getContainerExecutor();
}

function initializedExecutors(): Executor[] {
  return [containerExecutor, hostExecutor].filter((value): value is Executor =>
    Boolean(value),
  );
}

function parseAdditionalMountsCount(): number {
  const bindCount = parseBindSpecs(CONTAINER_BINDS).mounts.length;
  const legacyCount =
    parseLegacyAdditionalMounts(ADDITIONAL_MOUNTS).mounts.length;
  return bindCount + legacyCount;
}

export function getActiveExecutorCount(): number {
  const executors = initializedExecutors();
  if (executors.length === 0) return getExecutor().getActiveSessionCount();
  return executors.reduce(
    (sum, executor) => sum + executor.getActiveSessionCount(),
    0,
  );
}

export function getActiveExecutorSessionIds(): string[] {
  const executors = initializedExecutors();
  const active = (executors.length === 0 ? [getExecutor()] : executors).flatMap(
    (executor) => executor.getActiveSessionIds(),
  );
  return Array.from(new Set(active)).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function stopSessionExecution(sessionId: string): boolean {
  let stopped = false;
  for (const executor of initializedExecutors()) {
    stopped = executor.stopSession(sessionId) || stopped;
  }
  if (stopped) return true;
  return getExecutor().stopSession(sessionId);
}

export function stopAllExecutions(): void {
  for (const executor of initializedExecutors()) {
    executor.stopAll();
  }
  if (initializedExecutors().length === 0) {
    getExecutor().stopAll();
  }
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
    warning:
      mode === 'host'
        ? 'Running in host mode without container isolation.'
        : null,
  };
}
