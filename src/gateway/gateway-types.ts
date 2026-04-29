import type { BaseMessageOptions } from 'discord.js';
import type { PromptMode, PromptPartName } from '../agent/prompt-hooks.js';
import type { SkillConfigChannelKind } from '../channels/channel.js';
import type {
  MSTeamsReplyStyle,
  RuntimeConfig,
  RuntimeDeploymentTunnelProvider,
  RuntimeDiscordChannelConfig,
  RuntimeMSTeamsChannelConfig,
  RuntimeSchedulerJob,
} from '../config/runtime-config.js';
import type { AgentScoreboardEntry } from '../skills/adaptive-skills-types.js';
import type { TunnelState } from '../tunnel/tunnel-provider.js';
import type { MediaContextItem } from '../types/container.js';
import type {
  ArtifactMetadata,
  PendingApproval,
  ToolExecution,
  ToolProgressEvent,
} from '../types/execution.js';
import type { MemoryCitation } from '../types/memory.js';
import type { McpServerConfig } from '../types/models.js';
import type { TokenUsageStats } from '../types/usage.js';

export type GatewayMessageComponents = NonNullable<
  BaseMessageOptions['components']
>;

export interface GatewayModelCatalogEntry {
  value: string;
  label: string;
  isFree: boolean;
  recommended?: boolean;
}

export interface GatewayCommandResult {
  kind: 'plain' | 'info' | 'error';
  title?: string;
  text: string;
  sessionId?: string;
  sessionKey?: string;
  mainSessionKey?: string;
  components?: GatewayMessageComponents;
  modelCatalog?: GatewayModelCatalogEntry[];
}

export interface GatewayAssistantPresentation {
  agentId: string;
  displayName: string;
  imageUrl?: string;
}

export interface GatewayChatResult {
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  pluginsUsed?: string[];
  skillUsed?: string;
  agentId?: string;
  assistantPresentation?: GatewayAssistantPresentation;
  model?: string;
  provider?: string;
  memoryCitations?: MemoryCitation[];
  components?: GatewayMessageComponents;
  sessionId?: string;
  sessionKey?: string;
  mainSessionKey?: string;
  artifacts?: Array<{
    path: string;
    filename: string;
    mimeType: string;
  }>;
  toolExecutions?: ToolExecution[];
  pendingApproval?: PendingApproval;
  tokenUsage?: TokenUsageStats;
  error?: string;
  effectiveUserPrompt?: string;
  userMessageId?: number;
  assistantMessageId?: number;
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

export interface GatewayChatThinkingDeltaEvent {
  type: 'thinking';
  delta: string;
}

export type GatewayMediaItem = MediaContextItem;

export interface GatewayChatApprovalEvent extends PendingApproval {
  type: 'approval';
  summary?: string;
}

export interface GatewayChatStreamResultEvent {
  type: 'result';
  result: GatewayChatResult;
}

export type GatewayChatStreamEvent =
  | GatewayChatToolProgressEvent
  | GatewayChatTextDeltaEvent
  | GatewayChatThinkingDeltaEvent
  | GatewayChatApprovalEvent
  | GatewayChatStreamResultEvent;

export interface GatewayChatRequestBody {
  sessionId: string;
  sessionMode?: 'new' | 'resume';
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string | null;
  content: string;
  media?: GatewayMediaItem[];
  agentId?: string | null;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
}

export interface GatewayChatRequest {
  sessionId: GatewayChatRequestBody['sessionId'];
  executionSessionId?: string;
  executorModeOverride?: 'host' | 'container';
  autoApproveTools?: boolean;
  neverAutoApproveTools?: string[];
  workspacePathOverride?: string;
  workspaceDisplayRootOverride?: string;
  maxTokens?: number;
  maxWallClockMs?: number | null;
  inactivityTimeoutMs?: number | null;
  bashProxy?:
    | {
        mode: 'docker-exec';
        containerName: string;
        cwd?: string;
      }
    | undefined;
  sessionMode?: GatewayChatRequestBody['sessionMode'];
  guildId: GatewayChatRequestBody['guildId'];
  channelId: GatewayChatRequestBody['channelId'];
  userId: GatewayChatRequestBody['userId'];
  username: GatewayChatRequestBody['username'];
  content: GatewayChatRequestBody['content'];
  media?: GatewayChatRequestBody['media'];
  agentId?: GatewayChatRequestBody['agentId'];
  chatbotId?: GatewayChatRequestBody['chatbotId'];
  model?: GatewayChatRequestBody['model'];
  enableRag?: GatewayChatRequestBody['enableRag'];
  promptMode?: PromptMode;
  includePromptParts?: PromptPartName[];
  omitPromptParts?: PromptPartName[];
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  onApprovalProgress?: (approval: PendingApproval) => void;
  onProactiveMessage?: (message: {
    channelId?: string;
    text: string;
    artifacts?: ArtifactMetadata[];
  }) => void | Promise<void>;
  abortSignal?: AbortSignal;
  source?: string;
}

export interface GatewayMediaUploadResult {
  media: GatewayMediaItem;
}

export interface GatewayCommandRequest {
  sessionId: string;
  sessionMode?: 'new' | 'resume';
  guildId: string | null;
  channelId: string;
  args: string[];
  userId?: string | null;
  username?: string | null;
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

export interface GatewayHistoryMessage {
  id: number;
  session_id: string;
  user_id: string;
  username: string | null;
  role: string;
  agent_id?: string | null;
  content: string;
  artifacts?: Array<{
    path: string;
    filename: string;
    mimeType: string;
  }>;
  created_at: string;
  assistantPresentation?: GatewayAssistantPresentation;
}

export interface GatewayHistoryToolBreakdownEntry {
  toolName: string;
  count: number;
}

export interface GatewayHistoryFileChanges {
  readCount: number;
  modifiedCount: number;
  createdCount: number;
  deletedCount: number;
}

export interface GatewayHistorySummary {
  messageCount: number;
  userMessageCount: number;
  toolCallCount: number;
  inputTokenCount: number;
  outputTokenCount: number;
  costUsd: number;
  toolBreakdown: GatewayHistoryToolBreakdownEntry[];
  fileChanges: GatewayHistoryFileChanges;
}

export interface GatewayHistoryBranchVariant {
  sessionId: string;
  messageId: number;
}

export interface GatewayHistoryBranchFamily {
  anchorSessionId: string;
  anchorMessageId: number;
  variants: GatewayHistoryBranchVariant[];
}

export interface GatewayHistoryResponse {
  sessionId: string;
  // Routing metadata for related chat session instances. These are not bearer
  // credentials and must never be used for authorization decisions.
  // If they ever become auth-relevant, remove them from web responses instead
  // of silently repurposing them.
  sessionKey?: string;
  mainSessionKey?: string;
  history: GatewayHistoryMessage[];
  bootstrapAutostart?: {
    status: 'idle' | 'starting' | 'completed';
    fileName: 'BOOTSTRAP.md' | 'OPENING.md';
  } | null;
  branchFamilies?: GatewayHistoryBranchFamily[];
  summary?: GatewayHistorySummary;
}

export interface GatewayChatBranchRequestBody {
  sessionId: string;
  beforeMessageId: number;
}

export interface GatewayChatBranchResponse {
  sessionId: string;
  sessionKey: string;
  mainSessionKey: string;
  copiedMessageCount: number;
}

export interface GatewayRecentChatSession {
  sessionId: string;
  title: string | null;
  searchSnippet?: string | null;
  lastActive: string;
  messageCount: number;
}

export interface GatewayRecentChatSessionsResponse {
  sessions: GatewayRecentChatSession[];
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

export interface GatewayProviderHealthEntry {
  kind: 'local' | 'remote';
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  modelCount?: number;
  detail?: string;
  /** True when the provider requires explicit re-authentication (e.g. expired OAuth token). */
  loginRequired?: boolean;
}

export interface GatewayPluginCommandSummary {
  name: string;
  description?: string;
}

export interface GatewayStatus {
  status: 'ok';
  webAuthConfigured: boolean;
  pid?: number;
  lifecycle?: {
    restartSupported: boolean;
    restartReason: string | null;
  };
  version: string;
  uptime: number;
  sessions: number;
  activeContainers: number;
  defaultAgentId: string;
  defaultModel: string;
  ragDefault: boolean;
  fullAuto?: {
    activeSessions: number;
  };
  timestamp: string;
  codex?: {
    authenticated: boolean;
    source: 'device-code' | 'browser-pkce' | 'codex-cli-import' | null;
    accountId: string | null;
    expiresAt: number | null;
    reloginRequired: boolean;
  };
  hybridai?: {
    apiKeyConfigured: boolean;
    apiKeySource: 'env' | 'runtime-secrets' | null;
  };
  sandbox?: {
    mode: 'container' | 'host';
    modeExplicit: boolean;
    runningInsideContainer: boolean;
    image: string | null;
    network: string | null;
    memory: string | null;
    memorySwap: string | null;
    cpus: string | null;
    securityFlags: string[];
    mountAllowlistPath: string;
    additionalMountsConfigured: number;
    activeSessions: number;
    activeSessionIds?: string[];
    warning: string | null;
  };
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
  discord?: {
    tokenConfigured: boolean;
    tokenSource: 'env' | 'runtime-secrets' | null;
  };
  slack?: {
    botTokenConfigured: boolean;
    botTokenSource: 'env' | 'runtime-secrets' | null;
    appTokenConfigured: boolean;
    appTokenSource: 'env' | 'runtime-secrets' | null;
  };
  telegram?: {
    tokenConfigured: boolean;
    tokenSource: 'config' | 'env' | 'runtime-secrets' | null;
  };
  email?: {
    passwordConfigured: boolean;
    passwordSource: 'config' | 'env' | 'runtime-secrets' | null;
  };
  imessage?: {
    passwordConfigured: boolean;
    passwordSource: 'config' | 'env' | 'runtime-secrets' | null;
  };
  voice?: {
    enabled: boolean;
    accountSidConfigured: boolean;
    fromNumberConfigured: boolean;
    authTokenConfigured: boolean;
    authTokenSource: 'config' | 'env' | 'runtime-secrets' | null;
    webhookPath: string;
    maxConcurrentCalls: number;
  };
  whatsapp?: {
    linked: boolean;
    jid: string | null;
    pairingQrText: string | null;
    pairingUpdatedAt: string | null;
  };
  signal?: {
    enabled: boolean;
    daemonUrlConfigured: boolean;
    accountConfigured: boolean;
    pairingStatus: 'idle' | 'starting' | 'qr' | 'complete' | 'error';
    pairingQrText: string | null;
    pairingUri: string | null;
    pairingUpdatedAt: string | null;
    pairingError: string | null;
    cliAvailable: boolean;
    cliPath: string;
    cliVersion: string | null;
    cliError: string | null;
  };
  providerHealth?: Partial<
    Record<
      | 'hybridai'
      | 'codex'
      | 'anthropic'
      | 'openrouter'
      | 'mistral'
      | 'huggingface'
      | 'gemini'
      | 'deepseek'
      | 'xai'
      | 'zai'
      | 'kimi'
      | 'minimax'
      | 'dashscope'
      | 'xiaomi'
      | 'kilo'
      | 'ollama'
      | 'lmstudio'
      | 'llamacpp'
      | 'vllm',
      GatewayProviderHealthEntry
    >
  >;
  localBackends?: Partial<
    Record<
      'ollama' | 'lmstudio' | 'llamacpp' | 'vllm',
      {
        reachable: boolean;
        latencyMs: number;
        error?: string;
        modelCount?: number;
      }
    >
  >;
  pluginCommands?: GatewayPluginCommandSummary[];
}

export interface GatewayAdminSession {
  id: string;
  guildId: string | null;
  channelId: string;
  agentId: string;
  chatbotId: string | null;
  effectiveChatbotId: string | null;
  model: string | null;
  effectiveModel: string;
  ragEnabled: boolean;
  messageCount: number;
  summary: string | null;
  compactionCount: number;
  taskCount: number;
  createdAt: string;
  lastActive: string;
}

export interface GatewayAdminEmailFolder {
  path: string;
  name: string;
  specialUse: string | null;
  total: number;
  unseen: number;
}

export interface GatewayAdminEmailMessageSummary {
  folder: string;
  uid: number;
  messageId: string | null;
  subject: string;
  fromAddress: string | null;
  fromName: string | null;
  preview: string | null;
  receivedAt: string | null;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
}

export interface GatewayAdminEmailParticipant {
  name: string | null;
  address: string | null;
}

export interface GatewayAdminEmailAttachment {
  filename: string | null;
  contentType: string | null;
  size: number | null;
}

export interface GatewayAdminEmailMessageMetadata {
  agentId: string | null;
  model: string | null;
  provider: string | null;
  totalTokens: number | null;
  tokenSource: 'api' | 'estimated' | null;
}

export interface GatewayAdminEmailMessageDetail
  extends GatewayAdminEmailMessageSummary {
  to: GatewayAdminEmailParticipant[];
  cc: GatewayAdminEmailParticipant[];
  bcc: GatewayAdminEmailParticipant[];
  replyTo: GatewayAdminEmailParticipant[];
  text: string | null;
  attachments: GatewayAdminEmailAttachment[];
  metadata: GatewayAdminEmailMessageMetadata | null;
}

export interface GatewayAdminEmailMailboxResponse {
  enabled: boolean;
  address: string;
  folders: GatewayAdminEmailFolder[];
  defaultFolder: string | null;
}

export interface GatewayAdminEmailFolderResponse {
  folder: string;
  offset: number;
  limit: number;
  previousOffset: number | null;
  nextOffset: number | null;
  messages: GatewayAdminEmailMessageSummary[];
}

export interface GatewayAdminEmailMessageResponse {
  message: GatewayAdminEmailMessageDetail | null;
  thread: GatewayAdminEmailMessageDetail[];
}

export interface GatewayAdminEmailDeleteResponse {
  deleted: true;
  targetFolder: string | null;
  permanent: boolean;
}

export interface GatewayAdminUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  callCount: number;
  totalToolCalls: number;
}

export interface GatewayAdminModelUsageRow extends GatewayAdminUsageSummary {
  model: string;
}

export type GatewayAdminTunnelHealth = 'healthy' | 'reconnecting' | 'down';

export interface GatewayAdminTunnelStatus {
  provider: RuntimeDeploymentTunnelProvider | null;
  publicUrl: string | null;
  state: TunnelState;
  health: GatewayAdminTunnelHealth;
  running: boolean;
  reconnectSupported: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
  nextReconnectAt: string | null;
  reconnectAttempt: number;
}

export interface GatewayAdminOverview {
  status: GatewayStatus;
  configPath: string;
  tunnel: GatewayAdminTunnelStatus;
  recentSessions: GatewayAdminSession[];
  usage: {
    daily: GatewayAdminUsageSummary;
    monthly: GatewayAdminUsageSummary;
    topModels: GatewayAdminModelUsageRow[];
  };
}

export interface GatewayAdminStatisticsTrendDay {
  date: string;
  newSessions: number;
  activeSessions: number;
  userMessages: number;
  assistantMessages: number;
  totalMessages: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
  toolCalls: number;
  costUsd: number;
}

export interface GatewayAdminStatisticsChannelRow {
  channelId: string;
  sessionCount: number;
  userMessages: number;
  assistantMessages: number;
  totalMessages: number;
}

export interface GatewayAdminStatisticsResponse {
  rangeDays: number;
  startDate: string;
  endDate: string;
  totals: {
    newSessions: number;
    activeSessions: number;
    totalMessages: number;
    userMessages: number;
    assistantMessages: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalCostUsd: number;
    callCount: number;
    totalToolCalls: number;
  };
  trend: GatewayAdminStatisticsTrendDay[];
  channels: GatewayAdminStatisticsChannelRow[];
}

export interface GatewaySessionCard {
  id: string;
  name: string;
  task: string;
  lastQuestion: string | null;
  lastAnswer: string | null;
  fullAutoEnabled: boolean;
  model: string;
  sessionId: string;
  channelId: string;
  channelName: string | null;
  agentId: string;
  startedAt: string;
  lastActive: string;
  runtimeMinutes: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  messageCount: number;
  toolCalls: number;
  status: 'active' | 'idle' | 'stopped';
  watcher: string;
  previewTitle: string;
  previewMeta: string | null;
  output: string[];
}

export interface GatewayLogicalAgentCard {
  id: string;
  name: string | null;
  model: string | null;
  chatbotId: string | null;
  enableRag: boolean | null;
  workspace: string | null;
  workspacePath: string;
  sessionCount: number;
  activeSessions: number;
  idleSessions: number;
  stoppedSessions: number;
  effectiveModels: string[];
  lastActive: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  monthlySpendUsd: number;
  messageCount: number;
  toolCalls: number;
  recentSessionId: string | null;
  status: 'active' | 'idle' | 'stopped' | 'unused';
}

export interface GatewayCollectionTotals {
  all: number;
  active: number;
  idle: number;
  stopped: number;
  running: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface GatewayLogicalAgentTotals extends GatewayCollectionTotals {
  unused: number;
}

export interface GatewayAgentsResponse {
  generatedAt: string;
  version: string;
  uptime: number;
  ralph: {
    enabled: boolean;
    maxIterations: number;
  };
  totals: {
    agents: GatewayLogicalAgentTotals;
    sessions: GatewayCollectionTotals;
  };
  agents: GatewayLogicalAgentCard[];
  sessions: GatewaySessionCard[];
}

export interface GatewayAgentListItem {
  id: string;
  name: string | null;
}

export interface GatewayAgentListResponse {
  agents: GatewayAgentListItem[];
}

export interface GatewayAdminJobAgent {
  id: string;
  name: string | null;
}

export interface GatewayAdminJobSession {
  sessionId: string;
  agentId: string;
  startedAt: string;
  lastActive: string;
  status: GatewaySessionCard['status'];
  lastAnswer: string | null;
  output: string[];
}

export interface GatewayAdminJobsContextResponse {
  agents: GatewayAdminJobAgent[];
  sessions: GatewayAdminJobSession[];
}

export interface GatewayAdminDeleteSessionResult {
  deleted: boolean;
  sessionId: string;
  deletedMessages: number;
  deletedTasks: number;
  deletedSemanticMemories: number;
  deletedUsageEvents: number;
  deletedAuditEntries: number;
  deletedStructuredAuditEntries: number;
  deletedApprovalEntries: number;
}

export interface GatewayAdminDiscordChannel {
  id: string;
  transport: 'discord';
  guildId: string;
  channelId: string;
  defaultMode: 'off' | 'mention' | 'free';
  config: RuntimeDiscordChannelConfig;
}

export interface GatewayAdminMSTeamsChannel {
  id: string;
  transport: 'msteams';
  guildId: string;
  channelId: string;
  defaultGroupPolicy: RuntimeConfig['msteams']['groupPolicy'];
  defaultReplyStyle: MSTeamsReplyStyle;
  defaultRequireMention: boolean;
  config: RuntimeMSTeamsChannelConfig;
}

export type GatewayAdminChannel =
  | GatewayAdminDiscordChannel
  | GatewayAdminMSTeamsChannel;

export interface GatewayAdminChannelsResponse {
  groupPolicy: RuntimeConfig['discord']['groupPolicy'];
  defaultTypingMode: RuntimeConfig['discord']['typingMode'];
  defaultDebounceMs: number;
  defaultAckReaction: string;
  defaultRateLimitPerUser: number;
  defaultMaxConcurrentPerChannel: number;
  slack: {
    enabled: boolean;
    groupPolicy: RuntimeConfig['slack']['groupPolicy'];
    dmPolicy: RuntimeConfig['slack']['dmPolicy'];
    defaultRequireMention: boolean;
    defaultReplyStyle: RuntimeConfig['slack']['replyStyle'];
  };
  msteams: {
    enabled: boolean;
    groupPolicy: RuntimeConfig['msteams']['groupPolicy'];
    dmPolicy: RuntimeConfig['msteams']['dmPolicy'];
    defaultRequireMention: boolean;
    defaultReplyStyle: RuntimeConfig['msteams']['replyStyle'];
  };
  channels: GatewayAdminChannel[];
}

export type GatewayAdminChannelUpsertRequest =
  | {
      transport?: 'discord';
      guildId: string;
      channelId: string;
      config: RuntimeDiscordChannelConfig;
    }
  | {
      transport: 'msteams';
      guildId: string;
      channelId: string;
      config: RuntimeMSTeamsChannelConfig;
    };

export interface GatewayAdminConfigResponse {
  path: string;
  config: RuntimeConfig;
}

export interface GatewayAdminAgentMarkdownFile {
  name: string;
  path: string;
  exists: boolean;
  updatedAt: string | null;
  sizeBytes: number | null;
}

export interface GatewayAdminAgentMarkdownRevision {
  id: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  source: 'save' | 'restore';
}

export interface GatewayAdminAgent {
  id: string;
  name: string | null;
  model: string | null;
  skills: string[] | null;
  chatbotId: string | null;
  enableRag: boolean | null;
  workspace: string | null;
  workspacePath: string;
  markdownFiles: GatewayAdminAgentMarkdownFile[];
}

export interface GatewayAdminAgentsResponse {
  agents: GatewayAdminAgent[];
}

export interface GatewayAdminAgentMarkdownFileResponse {
  agent: GatewayAdminAgent;
  file: GatewayAdminAgentMarkdownFile & {
    content: string;
    revisions: GatewayAdminAgentMarkdownRevision[];
  };
}

export interface GatewayAdminAgentMarkdownRevisionResponse {
  agent: GatewayAdminAgent;
  fileName: string;
  revision: GatewayAdminAgentMarkdownRevision & {
    content: string;
  };
}

export interface GatewayAdminModelCatalogEntry {
  id: string;
  discovered: boolean;
  backend: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | null;
  contextWindow: number | null;
  maxTokens: number | null;
  pricingUsdPerToken: {
    input: number | null;
    output: number | null;
  };
  capabilities: {
    vision: boolean;
    tools: boolean;
    jsonMode: boolean;
    reasoning: boolean;
  };
  metadataSources: string[];
  isReasoning: boolean;
  thinkingFormat: string | null;
  family: string | null;
  parameterSize: string | null;
  usageDaily: GatewayAdminUsageSummary | null;
  usageMonthly: GatewayAdminUsageSummary | null;
}

export interface GatewayAdminModelsResponse {
  defaultModel: string;
  providerStatus: GatewayStatus['providerHealth'];
  models: GatewayAdminModelCatalogEntry[];
}

export interface GatewayAdminSchedulerJob {
  id: string;
  source: 'config' | 'task';
  name: string;
  description: string | null;
  agentId: string | null;
  boardStatus: NonNullable<RuntimeSchedulerJob['boardStatus']> | null;
  maxRetries: number | null;
  enabled: boolean;
  schedule: RuntimeSchedulerJob['schedule'];
  action: RuntimeSchedulerJob['action'];
  delivery: RuntimeSchedulerJob['delivery'];
  lastRun: string | null;
  lastStatus: 'success' | 'error' | null;
  nextRunAt: string | null;
  disabled: boolean;
  consecutiveErrors: number;
  createdAt: string | null;
  sessionId: string | null;
  channelId: string | null;
  taskId: number | null;
}

export interface GatewayAdminSchedulerResponse {
  jobs: GatewayAdminSchedulerJob[];
}

export interface GatewayAdminMcpServer {
  name: string;
  enabled: boolean;
  summary: string;
  config: McpServerConfig;
}

export interface GatewayAdminMcpResponse {
  servers: GatewayAdminMcpServer[];
}

export interface GatewayAdminAuditEntry {
  id: number;
  sessionId: string;
  seq: number;
  eventType: string;
  timestamp: string;
  runId: string;
  parentRunId: string | null;
  payload: string;
  createdAt: string;
}

export interface GatewayAdminAuditResponse {
  query: string;
  sessionId: string;
  eventType: string;
  limit: number;
  entries: GatewayAdminAuditEntry[];
}

export interface GatewayAdminApprovalAgent {
  id: string;
  name: string | null;
  workspacePath: string;
}

export interface GatewayAdminPendingApproval {
  sessionId: string;
  agentId: string | null;
  approvalId: string;
  userId: string;
  prompt: string;
  createdAt: string;
  expiresAt: string;
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
  actionKey: string | null;
}

export interface GatewayAdminPolicyRule {
  index: number;
  action: 'allow' | 'deny';
  host: string;
  port: number | '*';
  methods: string[];
  paths: string[];
  agent: string;
  comment?: string;
  managedByPreset?: string;
}

export interface GatewayAdminPolicyState {
  exists: boolean;
  policyPath: string;
  workspacePath: string;
  defaultAction: 'allow' | 'deny';
  presets: string[];
  rules: GatewayAdminPolicyRule[];
}

export interface GatewayAdminPolicyPresetSummary {
  name: string;
  description: string;
}

export interface GatewayAdminApprovalsResponse {
  selectedAgentId: string;
  agents: GatewayAdminApprovalAgent[];
  pending: GatewayAdminPendingApproval[];
  policy: GatewayAdminPolicyState;
  availablePresets: GatewayAdminPolicyPresetSummary[];
}

export interface GatewayAdminSkill {
  name: string;
  description: string;
  category: string;
  shortDescription?: string;
  source: string;
  available: boolean;
  enabled: boolean;
  missing: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  always: boolean;
  tags: string[];
  relatedSkills: string[];
}

export interface GatewayAdminSkillsResponse {
  extraDirs: string[];
  disabled: string[];
  channelDisabled: Partial<Record<SkillConfigChannelKind, string[]>>;
  skills: GatewayAdminSkill[];
}

export interface GatewayAdminAgentSkillScore
  extends Omit<AgentScoreboardEntry['best_skills'][number], 'agent_id'> {
  agent_id: string;
}

export interface GatewayAdminAgentScoreboardEntry
  extends Omit<AgentScoreboardEntry, 'agent_id' | 'best_skills' | 'cv_path'> {
  agent_id: string;
  best_skills: GatewayAdminAgentSkillScore[];
}

export interface GatewayAdminAgentScoreboardResponse {
  observed_skill_count: number;
  agents: GatewayAdminAgentScoreboardEntry[];
}

export interface GatewayAdminPlugin {
  id: string;
  name: string | null;
  version: string | null;
  description: string | null;
  source: 'home' | 'project' | 'config';
  enabled: boolean;
  status: 'loaded' | 'failed';
  error: string | null;
  commands: string[];
  tools: string[];
  hooks: string[];
}

export interface GatewayAdminPluginsResponse {
  totals: {
    totalPlugins: number;
    enabledPlugins: number;
    failedPlugins: number;
    commands: number;
    tools: number;
    hooks: number;
  };
  plugins: GatewayAdminPlugin[];
}

export interface GatewayAdminToolCatalogEntry {
  name: string;
  group: string;
  kind: 'builtin' | 'plugin' | 'mcp' | 'other';
  recentCalls: number;
  recentErrors: number;
  lastUsedAt: string | null;
  recentErrorSamples: Array<{
    id: number;
    sessionId: string;
    timestamp: string;
    summary: string;
  }>;
}

export interface GatewayAdminToolGroup {
  label: string;
  tools: GatewayAdminToolCatalogEntry[];
}

export interface GatewayAdminToolExecution {
  id: number;
  toolName: string;
  sessionId: string;
  timestamp: string;
  durationMs: number | null;
  isError: boolean;
  summary: string | null;
}

export interface GatewayAdminToolsResponse {
  totals: {
    totalTools: number;
    builtinTools: number;
    mcpTools: number;
    otherTools: number;
    recentExecutions: number;
    recentErrors: number;
  };
  groups: GatewayAdminToolGroup[];
  recentExecutions: GatewayAdminToolExecution[];
}

export function renderGatewayCommand(result: GatewayCommandResult): string {
  if (!result.title) return result.text;
  return `${result.title}\n\n${result.text}`;
}
