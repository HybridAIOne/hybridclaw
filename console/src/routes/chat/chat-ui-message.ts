import type { ChatMessage } from '../../api/chat-types';

export type ThinkingChatMessage = Omit<ChatMessage, 'role' | 'content'> & {
  role: 'thinking';
  content: '';
};

export type DraftChatMessage = Omit<ChatMessage, 'role'> & {
  role: 'draft';
};

export interface TraceThinkingStep {
  kind: 'thinking';
  text: string;
}

export interface TraceDraftStep {
  kind: 'draft';
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

export type TraceStep = TraceThinkingStep | TraceDraftStep | TraceToolStep;

/**
 * Live activity trace for one assistant turn. Draft/thinking/tool steps render
 * expanded while the run is active and collapse once the final answer arrives.
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
  | DraftChatMessage
  | ThinkingChatMessage
  | TraceChatMessage;
