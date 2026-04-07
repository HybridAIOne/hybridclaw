import type { ChatMessage } from '../types/api.js';
import type { ContainerOutput, MediaContextItem } from '../types/container.js';
import type {
  PendingApproval,
  PluginRuntimeToolDefinition,
  ToolProgressEvent,
} from '../types/execution.js';
import type { ScheduledTask } from '../types/scheduler.js';

export interface ExecutorRequest {
  sessionId: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  executorModeOverride?: 'host' | 'container';
  model?: string;
  agentId?: string;
  workspacePathOverride?: string;
  workspaceDisplayRootOverride?: string;
  skipContainerSystemPrompt?: boolean;
  maxTokens?: number;
  maxWallClockMs?: number | null;
  inactivityTimeoutMs?: number | null;
  bashProxy?:
    | {
        mode: 'docker-exec';
        containerName: string;
        cwd?: string;
      }
    | undefined;
  channelId?: string;
  ralphMaxIterations?: number | null;
  fullAutoEnabled?: boolean;
  fullAutoNeverApproveTools?: string[];
  scheduledTasks?: ScheduledTask[];
  allowedTools?: string[];
  blockedTools?: string[];
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  onApprovalProgress?: (approval: PendingApproval) => void;
  abortSignal?: AbortSignal;
  media?: MediaContextItem[];
  audioTranscriptsPrepended?: boolean;
  pluginTools?: PluginRuntimeToolDefinition[];
}

export interface Executor {
  exec(request: ExecutorRequest): Promise<ContainerOutput>;
  getWorkspacePath(agentId: string): string;
  stopSession(sessionId: string): boolean;
  stopAll(): void;
  getActiveSessionCount(): number;
  getActiveSessionIds(): string[];
}
