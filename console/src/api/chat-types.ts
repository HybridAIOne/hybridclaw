export interface ChatRecentSession {
  sessionId: string;
  title: string;
  searchSnippet?: string | null;
  lastActive: string;
  messageCount: number;
}

export interface ChatRecentResponse {
  sessions: ChatRecentSession[];
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  id?: number | string | null;
}

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
  history: ChatHistoryMessage[];
  assistantPresentation?: AssistantPresentation | null;
  branchFamilies?: BranchFamily[];
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
  toolName?: string;
  args?: unknown;
  allowSession?: boolean;
  allowAgent?: boolean;
  allowAll?: boolean;
  expiresAt?: number | null;
}

export type ChatStreamEvent = ChatStreamTextDelta | ChatStreamApproval;

export interface ChatStreamResult {
  status?: string;
  error?: string;
  sessionId?: string;
  userMessageId?: number | string | null;
  assistantMessageId?: number | string | null;
  result?: string;
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

export interface CommandResponse {
  status?: string;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'approval';
  content: string;
  rawContent?: string;
  sessionId: string;
  messageId?: number | string | null;
  media?: MediaItem[];
  artifacts?: ChatArtifact[];
  replayRequest?: { content: string; media: MediaItem[] } | null;
  pendingApproval?: ChatStreamApproval | null;
  assistantPresentation?: AssistantPresentation | null;
  branchKey?: string | null;
}
