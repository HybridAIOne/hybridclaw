import type {
  ChatMessage,
  ContainerOutput,
  MediaContextItem,
  PendingApproval,
  ScheduledTask,
  ToolProgressEvent,
} from '../types.js';
import type { BootstrapContextMode } from '../workspace.js';

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
  bootstrapContextMode?: BootstrapContextMode;
}

export interface Executor {
  exec(request: ExecutorRequest): Promise<ContainerOutput>;
  getWorkspacePath(agentId: string): string;
  stopSession(sessionId: string): boolean;
  stopAll(): void;
  getActiveSessionCount(): number;
  getActiveSessionIds(): string[];
}
