import type { ChatMessage } from '../../api/chat-types';

export type ThinkingChatMessage = Omit<ChatMessage, 'role' | 'content'> & {
  role: 'thinking';
  content: '';
};

export interface TraceThinkingStep {
  kind: 'thinking';
  text: string;
}

export interface TraceToolStep {
  kind: 'tool';
  toolName: string;
  status: 'running' | 'done';
  argsPreview?: string;
  resultPreview?: string;
  durationMs?: number;
}

export type TraceStep = TraceThinkingStep | TraceToolStep;

/**
 * Live activity trace for one assistant turn (thinking + tool calls streamed
 * by the gateway). Rendered as a collapsible block above the answer bubble;
 * exists only for runs streamed in this browser session — server history does
 * not persist it.
 */
export type TraceChatMessage = Omit<ChatMessage, 'role' | 'content'> & {
  role: 'trace';
  content: '';
  steps: TraceStep[];
  /** True once the run finished (answer, error, or stop) — collapses the block. */
  done: boolean;
  startedAt: number;
  finishedAt?: number;
};

export type ChatUiMessage =
  | ChatMessage
  | ThinkingChatMessage
  | TraceChatMessage;
