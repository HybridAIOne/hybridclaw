import type { ChatMessage } from '../types/api.js';
import type {
  ContainerOutput,
  MediaContextItem,
  PendingApproval,
  PluginRuntimeToolDefinition,
  ToolProgressEvent,
} from '../types/container.js';
import type { ScheduledTask } from '../types/scheduler.js';

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
