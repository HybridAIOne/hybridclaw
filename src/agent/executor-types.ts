import type { ChatMessage } from '../types/api.js';
import type { ContainerOutput, MediaContextItem } from '../types/container.js';
import type {
  EscalationTarget,
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
  executorModeOverride?: 'host' | 'container' | undefined;
  model?: string | undefined;
  agentId?: string | undefined;
  workspacePathOverride?: string | undefined;
  workspaceDisplayRootOverride?: string | undefined;
  skipContainerSystemPrompt?: boolean | undefined;
  maxTokens?: number | undefined;
  maxWallClockMs?: number | null | undefined;
  inactivityTimeoutMs?: number | null | undefined;
  bashProxy?:
    | {
        mode: 'docker-exec';
        containerName: string;
        cwd?: string | undefined;
      }
    | undefined;
  channelId?: string | undefined;
  ralphMaxIterations?: number | null | undefined;
  fullAutoEnabled?: boolean | undefined;
  fullAutoNeverApproveTools?: string[] | undefined;
  scheduledTasks?: ScheduledTask[] | undefined;
  allowedTools?: string[] | undefined;
  blockedTools?: string[] | undefined;
  onTextDelta?: ((delta: string) => void) | undefined;
  onThinkingDelta?: ((delta: string) => void) | undefined;
  onToolProgress?: ((event: ToolProgressEvent) => void) | undefined;
  onApprovalProgress?: ((approval: PendingApproval) => void) | undefined;
  abortSignal?: AbortSignal | undefined;
  media?: MediaContextItem[] | undefined;
  audioTranscriptsPrepended?: boolean | undefined;
  pluginTools?: PluginRuntimeToolDefinition[] | undefined;
  escalationTarget?: EscalationTarget | undefined;
}

export interface Executor {
  exec(request: ExecutorRequest): Promise<ContainerOutput>;
  getWorkspacePath(agentId: string): string;
  stopSession(sessionId: string): boolean;
  stopAll(): void;
  getActiveSessionCount(): number;
  getActiveSessionIds(): string[];
  getSessionHealthSnapshots(): Promise<ExecutorSessionHealthSnapshot[]>;
}

export interface ExecutorSessionHealthSnapshot {
  mode: 'container' | 'host';
  sessionId: string;
  agentId: string;
  responsive: boolean;
  startedAt: number;
  lastUsedAt: number;
  readyForInputAt: number | null;
  busy: boolean;
  terminalError: string | null;
  healthError: string | null;
}
