/**
 * Container Runner — thin shim that delegates to the active ContainerBackend.
 * Backend is selected via HYBRIDCLAW_BACKEND env var (default: 'docker').
 */
import {
  HYBRIDAI_MODEL,
  MAX_CONCURRENT_CONTAINERS,
} from './config.js';
import { logger } from './logger.js';
import type { ChatMessage, ContainerOutput, ScheduledTask, ToolProgressEvent } from './types.js';
import { DockerBackend } from './backends/docker.js';
import type { ContainerBackend } from './backends/types.js';

function createBackend(): ContainerBackend {
  const backendName = (process.env.HYBRIDCLAW_BACKEND || 'docker').toLowerCase();
  if (backendName === 'docker') {
    return new DockerBackend();
  }
  logger.warn({ backend: backendName }, 'Unknown HYBRIDCLAW_BACKEND, falling back to docker');
  return new DockerBackend();
}

const backend: ContainerBackend = createBackend();

export function getActiveContainerCount(): number {
  return backend.getActiveCount();
}

/**
 * Send a request to a persistent container and wait for the response.
 */
export async function runContainer(
  sessionId: string,
  messages: ChatMessage[],
  chatbotId: string,
  enableRag: boolean,
  model: string = HYBRIDAI_MODEL,
  agentId: string = chatbotId,
  channelId: string = '',
  scheduledTasks?: ScheduledTask[],
  allowedTools?: string[],
  onToolProgress?: (event: ToolProgressEvent) => void,
  abortSignal?: AbortSignal,
): Promise<ContainerOutput> {
  return backend.run(sessionId, messages, {
    chatbotId,
    enableRag,
    model,
    agentId,
    channelId,
    scheduledTasks,
    allowedTools,
    onToolProgress,
    abortSignal,
  });
}

/**
 * Stop all containers (for graceful shutdown).
 */
export function stopAllContainers(): void {
  backend.stopAll();
}
