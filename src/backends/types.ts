import type { ChatMessage, ContainerOutput, ScheduledTask, ToolProgressEvent } from '../types.js';

export interface RunContainerOptions {
  chatbotId: string;
  enableRag: boolean;
  model: string;
  agentId: string;
  channelId: string;
  scheduledTasks?: ScheduledTask[];
  allowedTools?: string[];
  onToolProgress?: (event: ToolProgressEvent) => void;
  abortSignal?: AbortSignal;
}

export interface ContainerBackend {
  run(
    sessionId: string,
    messages: ChatMessage[],
    options: RunContainerOptions,
  ): Promise<ContainerOutput>;
  stop(containerName: string): void;
  stopAll(): void;
  getActiveCount(): number;
}
