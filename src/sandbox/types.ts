import type { ToolProgressEvent } from '../types.js';

export type { ToolProgressEvent };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  /** Set by the delegate tool to signal delegation back to the gateway. */
  isDelegate?: boolean;
}

export interface AgentLoopOptions {
  chatbotId: string;
  model: string;
  enableRag: boolean;
  agentId: string;
  channelId: string;
  allowedTools?: string[];
  scheduledTasks?: unknown[];
  onToolProgress?: (event: ToolProgressEvent) => void;
  abortSignal?: AbortSignal;
  /** Override the HybridAI API base URL (used in tests to point at a mock server). */
  hybridAiBaseUrl?: string;
}

export interface StreamChunk {
  type: 'stdout' | 'stderr' | 'exit';
  text?: string;
  exitCode?: number;
}
