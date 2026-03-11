// --- HybridAI API types ---

export interface ChatContentTextPart {
  type: 'text';
  text: string;
}

export interface ChatContentImageUrlPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type ChatContentPart = ChatContentTextPart | ChatContentImageUrlPart;
export type ChatMessageContent = string | ChatContentPart[] | null;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatMessageContent;
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

export interface MediaContextItem {
  path: string | null;
  url: string;
  originalUrl: string;
  mimeType: string | null;
  sizeBytes: number;
  filename: string;
}

export interface McpServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface ContainerInput {
  sessionId: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  apiKey: string;
  baseUrl: string;
  provider?: 'hybridai' | 'openai-codex' | 'ollama' | 'lmstudio' | 'vllm';
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
  gatewayBaseUrl?: string;
  gatewayApiToken?: string;
  model: string;
  maxTokens?: number;
  channelId: string;
  configuredDiscordChannels?: string[];
  scheduledTasks?: {
    id: number;
    cronExpr: string;
    runAt: string | null;
    everyMs: number | null;
    prompt: string;
    enabled: number;
    lastRun: string | null;
    createdAt: string;
  }[];
  allowedTools?: string[];
  blockedTools?: string[];
  media?: MediaContextItem[];
  mcpServers?: Record<string, McpServerConfig>;
  webSearch?: {
    provider:
      | 'auto'
      | 'brave'
      | 'perplexity'
      | 'tavily'
      | 'duckduckgo'
      | 'searxng';
    fallbackProviders: (
      | 'brave'
      | 'perplexity'
      | 'tavily'
      | 'duckduckgo'
      | 'searxng'
    )[];
    defaultCount: number;
    cacheTtlMinutes: number;
    searxngBaseUrl: string;
    tavilySearchDepth: 'basic' | 'advanced';
  };
}

export interface ToolExecution {
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
}

export interface ToolProgressEvent {
  sessionId: string;
  toolName: string;
  phase: 'start' | 'finish';
  preview?: string;
  durationMs?: number;
}

export interface TokenUsageStats {
  modelCalls: number;
  apiUsageAvailable: boolean;
  apiPromptTokens: number;
  apiCompletionTokens: number;
  apiTotalTokens: number;
  apiCacheUsageAvailable: boolean;
  apiCacheReadTokens: number;
  apiCacheWriteTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTotalTokens: number;
}

export interface ArtifactMetadata {
  path: string;
  filename: string;
  mimeType: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  artifacts?: ArtifactMetadata[];
  toolExecutions?: ToolExecution[];
  tokenUsage?: TokenUsageStats;
  error?: string;
  effectiveUserPrompt?: string;
  sideEffects?: {
    schedules?: ScheduleSideEffect[];
    delegations?: DelegationSideEffect[];
  };
}

export type ScheduleSideEffect =
  | {
      action: 'add';
      cronExpr?: string;
      runAt?: string;
      everyMs?: number;
      prompt: string;
    }
  | { action: 'remove'; taskId: number };

export interface DelegationTaskSpec {
  prompt: string;
  label?: string;
  model?: string;
}

export interface DelegationSideEffect {
  action: 'delegate';
  mode?: 'single' | 'parallel' | 'chain';
  prompt?: string;
  label?: string;
  model?: string;
  tasks?: DelegationTaskSpec[];
  chain?: DelegationTaskSpec[];
}

// --- Database types ---

export interface Session {
  id: string;
  guild_id: string | null;
  channel_id: string;
  chatbot_id: string | null;
  model: string | null;
  enable_rag: number;
  message_count: number;
  session_summary: string | null;
  summary_updated_at: string | null;
  compaction_count: number;
  memory_flush_at: string | null;
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

export interface SemanticMemoryEntry {
  id: number;
  session_id: string;
  role: string;
  source: string;
  scope: string;
  metadata: Record<string, unknown>;
  content: string;
  confidence: number;
  embedding: number[] | null;
  source_message_id: number | null;
  created_at: string;
  accessed_at: string;
  access_count: number;
}

export interface StructuredMemoryEntry {
  agent_id: string;
  key: string;
  value: unknown;
  version: number;
  updated_at: string;
}

export interface ArchiveEntry {
  sessionId: string;
  path: string;
  archivedAt: string;
  messageCount: number;
  estimatedTokens: number;
}

export interface CompactionStage {
  kind: 'single' | 'part' | 'merge';
  index: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

export interface CompactionConfig {
  keepRecentMessages: number;
  compactRatio: number;
  baseChunkRatio: number;
  minChunkRatio: number;
  safetyMargin: number;
  maxSingleStageTokens: number;
  minSummaryTokens: number;
  maxSummaryTokens: number;
  maxSummaryChars: number;
  archiveBaseDir?: string;
}

export interface CompactionResult {
  tokensBefore: number;
  tokensAfter: number;
  messagesCompacted: number;
  messagesPreserved: number;
  archivePath: string;
  durationMs: number;
  stages: CompactionStage[];
}

export enum KnowledgeEntityType {
  Person = 'person',
  Organization = 'organization',
  Project = 'project',
  Concept = 'concept',
  Event = 'event',
  Location = 'location',
  Document = 'document',
  Tool = 'tool',
}

export interface KnowledgeEntityCustomType {
  custom: string;
}

export type KnowledgeEntityTypeValue =
  | KnowledgeEntityType
  | KnowledgeEntityCustomType;

export enum KnowledgeRelationType {
  WorksAt = 'works_at',
  KnowsAbout = 'knows_about',
  RelatedTo = 'related_to',
  DependsOn = 'depends_on',
  OwnedBy = 'owned_by',
  CreatedBy = 'created_by',
  LocatedIn = 'located_in',
  PartOf = 'part_of',
  Uses = 'uses',
  Produces = 'produces',
}

export interface KnowledgeRelationCustomType {
  custom: string;
}

export type KnowledgeRelationTypeValue =
  | KnowledgeRelationType
  | KnowledgeRelationCustomType;

export interface KnowledgeEntity {
  id: string;
  entity_type: KnowledgeEntityTypeValue;
  name: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeRelation {
  source: string;
  relation: KnowledgeRelationTypeValue;
  target: string;
  properties: Record<string, unknown>;
  confidence: number;
  created_at: string;
}

export interface KnowledgeGraphPattern {
  source?: string;
  relation?: KnowledgeRelationTypeValue;
  target?: string;
  max_depth?: number;
}

export interface KnowledgeGraphMatch {
  source: KnowledgeEntity;
  relation: KnowledgeRelation;
  target: KnowledgeEntity;
}

export interface CanonicalSessionMessage {
  role: string;
  content: string;
  session_id: string;
  channel_id: string | null;
  created_at: string;
}

export interface CanonicalSession {
  canonical_id: string;
  agent_id: string;
  user_id: string;
  messages: CanonicalSessionMessage[];
  compaction_cursor: number;
  compacted_summary: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface CanonicalSessionContext {
  summary: string | null;
  recent_messages: CanonicalSessionMessage[];
}

export type UsageWindow = 'daily' | 'monthly' | 'all';

export interface UsageTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
  total_tool_calls: number;
}

export interface UsageModelAggregate {
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
  total_tool_calls: number;
}

export interface UsageAgentAggregate {
  agent_id: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
  total_tool_calls: number;
}

export interface UsageDailyAggregate {
  day: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
  total_tool_calls: number;
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
  last_status: string | null;
  consecutive_errors: number;
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

export interface StructuredAuditEntry {
  id: number;
  session_id: string;
  seq: number;
  event_type: string;
  timestamp: string;
  run_id: string;
  parent_run_id: string | null;
  payload: string;
  wire_hash: string;
  wire_prev_hash: string;
  created_at: string;
}

export interface ApprovalAuditEntry {
  id: number;
  session_id: string;
  tool_call_id: string;
  action: string;
  description: string | null;
  approved: number;
  approved_by: string | null;
  method: string;
  policy_name: string | null;
  timestamp: string;
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
