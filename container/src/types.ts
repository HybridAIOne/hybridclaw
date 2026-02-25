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

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  model: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

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
