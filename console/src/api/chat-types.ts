export interface ChatRecentSession {
  sessionId: string;
  title: string | null;
  searchSnippet?: string | null;
  lastActive: string;
  messageCount: number;
}

export interface ChatRecentResponse {
  sessions: ChatRecentSession[];
}

export interface ChatCleanupResponse {
  deletedCount: number;
  deletedSessionIds: string[];
  keptSessionId?: string;
}

export interface ChatMobileQrResponse {
  launchUrl: string;
  expiresAt: string;
  qrSvg: string;
}

export interface ChatActivityTraceThinkingStep {
  kind: 'thinking';
  text: string;
}

export interface ChatActivityTraceDraftStep {
  kind: 'draft';
  text: string;
}

export interface ChatActivityTraceToolStep {
  kind: 'tool';
  toolName: string;
  status?: 'running' | 'done';
  argsPreview?: string;
  resultPreview?: string;
  durationMs?: number;
}

export type ChatActivityTraceStep =
  | ChatActivityTraceThinkingStep
  | ChatActivityTraceDraftStep
  | ChatActivityTraceToolStep;

/** Persisted per-message activity trace replayed from chat history. */
export interface ChatActivityTrace {
  steps: ChatActivityTraceStep[];
  elapsedMs?: number;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  id?: number | string | null;
  agent_id?: string | null;
  response_rating?: ResponseRatingValue | null;
  artifacts?: ChatArtifact[];
  assistantPresentation?: AssistantPresentation | null;
  activityTrace?: ChatActivityTrace | null;
}

export type ResponseRatingValue = 'up' | 'down';

export interface AssistantPresentation {
  agentId?: string | null;
  displayName?: string | null;
  imageUrl?: string | null;
}

export interface BranchFamily {
  anchorSessionId: string;
  anchorMessageId: number | string;
  variants: BranchVariant[];
}

export interface BranchVariant {
  sessionId: string;
  messageId: number | string;
}

export interface ChatHistoryResponse {
  sessionId?: string;
  agentId?: string | null;
  history: ChatHistoryMessage[];
  assistantPresentation?: AssistantPresentation | null;
  bootstrapAutostart?: {
    status: 'idle' | 'starting' | 'completed';
    fileName: 'BOOTSTRAP.md' | 'OPENING.md';
  } | null;
  branchFamilies?: BranchFamily[];
}

export interface ChatContextSnapshot {
  sessionId: string;
  model: string;
  contextUsedTokens: number | null;
  contextBudgetTokens: number | null;
  contextUsagePercent: number | null;
  contextRemainingTokens: number | null;
  compactionCount: number;
  compactionTokenBudget: number;
  compactionMessageThreshold: number;
  compactionKeepRecent: number;
  messageCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ChatContextResponse {
  sessionId: string;
  snapshot: ChatContextSnapshot | null;
}

export interface ChatCommandSuggestion {
  id: string;
  label: string;
  insertText: string;
  description: string;
  imageUrl?: string | null;
  depth?: number;
}

export interface ChatCommandsResponse {
  commands: ChatCommandSuggestion[];
}

export interface ChatArtifact {
  filename?: string;
  path?: string;
  mimeType?: string;
  type?: string;
}

export type OutputSegmentKind =
  | 'draft'
  | 'final'
  | 'tool_request'
  | 'approval'
  | 'status';
export type OutputDisplaySurface = 'none' | 'assistant_bubble' | 'approval';

export interface OutputPresentationMetadata {
  segmentKind: OutputSegmentKind;
  visible: boolean;
  displaySurface: OutputDisplaySurface;
}

export interface ChatStreamTextDelta {
  type: 'text';
  delta: string;
  outputPresentation?: OutputPresentationMetadata;
}

export interface ChatStreamThinkingDelta {
  type: 'thinking';
  delta: string;
}

export interface ChatStreamToolEvent {
  type: 'tool';
  toolName: string;
  phase: 'start' | 'finish';
  preview?: string;
  durationMs?: number;
}

export interface ChatStreamApproval {
  type: 'approval';
  approvalId: string;
  prompt: string;
  summary?: string;
  intent?: string;
  reason?: string;
  approvalTier?: 'green' | 'yellow' | 'red';
  toolName?: string;
  commandPreview?: string;
  args?: unknown;
  allowSession?: boolean;
  allowAgent?: boolean;
  allowAll?: boolean;
  expiresAt?: number | null;
}

export type ChatStreamEvent =
  | ChatStreamTextDelta
  | ChatStreamThinkingDelta
  | ChatStreamToolEvent
  | ChatStreamApproval;

export type ChatResultMessageRole = 'assistant' | 'approval' | 'command';

export type A2ADeliveryState = 'pending' | 'delivered' | 'failed' | 'unknown';

/**
 * Describes an outbound A2A message a chat send produced, so the UI can render
 * a live delivery-status chip and poll for its final state.
 */
export interface A2ADeliveryDescriptor {
  messageId: string;
  threadId: string;
  recipientAgentId: string;
  status: A2ADeliveryState;
}

export interface ChatStreamResult {
  status?: string;
  error?: string;
  /** UI role for the result message. */
  messageRole?: ChatResultMessageRole;
  outputPresentation?: OutputPresentationMetadata;
  sessionId?: string;
  userMessageId?: number | string | null;
  assistantMessageId?: number | string | null;
  result?: string;
  addressEnvelope?: {
    to: string | string[];
    from?: string | null;
    fanoutAlias?: 'team' | 'all';
  };
  assistantPresentation?: AssistantPresentation | null;
  model?: string;
  provider?: string;
  artifacts?: ChatArtifact[];
  apps?: Array<{ id: string; title: string; kind: 'web' | 'live' }>;
  toolsUsed?: string[];
  a2aDelivery?: A2ADeliveryDescriptor | null;
}

export interface MediaItem {
  filename: string;
  path: string;
  mimeType: string;
}

export interface MediaUploadResponse {
  media: MediaItem;
}

export interface BranchResponse {
  sessionId: string;
}

export interface RateResponseRequest {
  sessionId: string;
  messageId: number | string;
  userId?: string;
  rating: ResponseRatingValue | null;
}

export interface RateResponseResponse {
  sessionId: string;
  messageId: number;
  rating: ResponseRatingValue | null;
}

export interface ChatMessage {
  id: string;
  // `command` is slash-command/console output (rendered as a distinct terminal
  // block); `system` is reserved for plain notices such as error messages.
  role: 'user' | 'assistant' | 'system' | 'approval' | 'command';
  content: string;
  rawContent?: string;
  sessionId: string;
  messageId?: number | string | null;
  media?: MediaItem[];
  artifacts?: ChatArtifact[];
  replayRequest?: { content: string; media: MediaItem[] } | null;
  pendingApproval?: ChatStreamApproval | null;
  assistantPresentation?: AssistantPresentation | null;
  addressedAgentPresentation?: AssistantPresentation | null;
  responseRating?: ResponseRatingValue | null;
  branchKey?: string | null;
  a2aDelivery?: A2ADeliveryDescriptor | null;
}
