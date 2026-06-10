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

export interface ChatMobileQrResponse {
  launchUrl: string;
  expiresAt: string;
  qrSvg: string;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  id?: number | string | null;
  agent_id?: string | null;
  response_rating?: ResponseRatingValue | null;
  artifacts?: ChatArtifact[];
  assistantPresentation?: AssistantPresentation | null;
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

export interface ChatStreamTextDelta {
  type: 'text';
  delta: string;
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

export type ChatStreamEvent = ChatStreamTextDelta | ChatStreamApproval;

export type ChatResultMessageRole = 'assistant' | 'approval' | 'command';

export interface ChatStreamResult {
  status?: string;
  error?: string;
  /** UI role for the result message. */
  messageRole?: ChatResultMessageRole;
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
  toolsUsed?: string[];
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
}
