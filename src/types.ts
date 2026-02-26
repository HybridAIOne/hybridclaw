// --- HybridAI API types ---

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface HybridAIBot {
  id: string;
  name: string;
  description?: string;
}

// --- Container IPC types ---

export interface ContainerInput {
  sessionId: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  channelId: string;
  scheduledTasks?: { id: number; cronExpr: string; runAt: string | null; everyMs: number | null; prompt: string; enabled: number; lastRun: string | null; createdAt: string }[];
  allowedTools?: string[];
}

export interface ToolExecution {
  name: string;
  arguments: string;
  result: string;
  durationMs: number;
}

export interface ToolProgressEvent {
  sessionId: string;
  toolName: string;
  phase: 'start' | 'finish';
  preview?: string;
  durationMs?: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  toolExecutions?: ToolExecution[];
  error?: string;
  sideEffects?: { schedules?: ScheduleSideEffect[] };
}

export type ScheduleSideEffect =
  | { action: 'add'; cronExpr?: string; runAt?: string; everyMs?: number; prompt: string }
  | { action: 'remove'; taskId: number };

// --- Database types ---

export interface Session {
  id: string;
  guild_id: string | null;
  channel_id: string;
  chatbot_id: string | null;
  model: string | null;
  enable_rag: number;
  message_count: number;
  created_at: string;
  last_active: string;
}

export interface StoredMessage {
  id: number;
  session_id: string;
  user_id: string;
  username: string | null;
  role: string;
  content: string;
  created_at: string;
}

export interface ScheduledTask {
  id: number;
  session_id: string;
  channel_id: string;
  cron_expr: string;
  run_at: string | null;
  every_ms: number | null;
  prompt: string;
  enabled: number;
  last_run: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  session_id: string | null;
  event: string;
  detail: string | null;
  duration_ms: number | null;
  created_at: string;
}

// --- Mount security types ---

export interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean; // Default: true
}

export interface MountAllowlist {
  allowedRoots: AllowedRoot[];
  blockedPatterns: string[];
}

export interface AllowedRoot {
  path: string;
  allowReadWrite: boolean;
  description?: string;
}
