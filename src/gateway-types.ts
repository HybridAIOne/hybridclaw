import type { TokenUsageStats } from './types.js';

export interface GatewayCommandResult {
  kind: 'plain' | 'info' | 'error';
  title?: string;
  text: string;
}

export interface GatewayChatResult {
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  artifacts?: Array<{
    path: string;
    filename: string;
    mimeType: string;
  }>;
  toolExecutions?: Array<{
    name: string;
    arguments: string;
    result: string;
    durationMs: number;
    isError?: boolean;
    blocked?: boolean;
    blockedReason?: string;
    approvalTier?: 'green' | 'yellow' | 'red';
    approvalBaseTier?: 'green' | 'yellow' | 'red';
    approvalDecision?:
      | 'auto'
      | 'implicit'
      | 'approved_once'
      | 'approved_session'
      | 'approved_agent'
      | 'promoted'
      | 'required'
      | 'denied';
    approvalActionKey?: string;
    approvalReason?: string;
    approvalRequestId?: string;
  }>;
  tokenUsage?: TokenUsageStats;
  error?: string;
  effectiveUserPrompt?: string;
}

export interface GatewayChatToolProgressEvent {
  type: 'tool';
  phase: 'start' | 'finish';
  toolName: string;
  preview?: string;
  durationMs?: number;
}

export interface GatewayChatTextDeltaEvent {
  type: 'text';
  delta: string;
}

export interface GatewayChatStreamResultEvent {
  type: 'result';
  result: GatewayChatResult;
}

export type GatewayChatStreamEvent =
  | GatewayChatToolProgressEvent
  | GatewayChatTextDeltaEvent
  | GatewayChatStreamResultEvent;

export interface GatewayChatRequestBody {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string | null;
  content: string;
  media?: Array<{
    path: string | null;
    url: string;
    originalUrl: string;
    mimeType: string | null;
    sizeBytes: number;
    filename: string;
  }>;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
}

export interface GatewayCommandRequest {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  args: string[];
}

export interface GatewayProactiveMessage {
  id: number;
  channel_id: string;
  text: string;
  source: string;
  queued_at: string;
}

export interface GatewayProactivePullResponse {
  channelId: string;
  messages: GatewayProactiveMessage[];
}

export interface GatewaySchedulerJobStatus {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: 'success' | 'error' | null;
  nextRunAt: string | null;
  disabled: boolean;
  consecutiveErrors: number;
}

export interface GatewayStatus {
  status: 'ok';
  pid?: number;
  version: string;
  uptime: number;
  sessions: number;
  activeContainers: number;
  defaultModel: string;
  ragDefault: boolean;
  timestamp: string;
  observability?: {
    enabled: boolean;
    running: boolean;
    paused: boolean;
    reason: string | null;
    streamKey: string | null;
    lastCursor: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastError: string | null;
  };
  scheduler?: {
    jobs: GatewaySchedulerJobStatus[];
  };
}

export function renderGatewayCommand(result: GatewayCommandResult): string {
  if (!result.title) return result.text;
  return `${result.title}\n${result.text}`;
}
