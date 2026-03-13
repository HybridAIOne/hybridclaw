import type { BaseMessageOptions } from 'discord.js';
import type {
  RuntimeConfig,
  RuntimeDiscordChannelConfig,
  RuntimeSchedulerJob,
} from '../config/runtime-config.js';
import type { McpServerConfig, TokenUsageStats } from '../types.js';

export type GatewayMessageComponents = NonNullable<
  BaseMessageOptions['components']
>;

export interface GatewayModelCatalogEntry {
  value: string;
  label: string;
  isFree: boolean;
}

export interface GatewayCommandResult {
  kind: 'plain' | 'info' | 'error';
  title?: string;
  text: string;
  components?: GatewayMessageComponents;
  modelCatalog?: GatewayModelCatalogEntry[];
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
      | 'approved_fullauto'
      | 'promoted'
      | 'required'
      | 'denied';
    approvalActionKey?: string;
    approvalReason?: string;
    approvalRequestId?: string;
    approvalExpiresAt?: number;
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
  agentId?: string | null;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
}

export interface GatewayCommandRequest {
  sessionId: string;
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
}

export interface GatewayStatus {
  status: 'ok';
  webAuthConfigured: boolean;
  pid?: number;
  version: string;
  uptime: number;
  sessions: number;
  activeContainers: number;
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
  providerHealth?: Partial<
    Record<
      'hybridai' | 'codex' | 'ollama' | 'lmstudio' | 'vllm',
      GatewayProviderHealthEntry
    >
  >;
  localBackends?: Partial<
    Record<
      'ollama' | 'lmstudio' | 'vllm',
      {
        reachable: boolean;
        latencyMs: number;
        error?: string;
        modelCount?: number;
      }
    >
  >;
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

export interface GatewayAdminOverview {
  status: GatewayStatus;
  configPath: string;
  recentSessions: GatewayAdminSession[];
  usage: {
    daily: GatewayAdminUsageSummary;
    monthly: GatewayAdminUsageSummary;
    topModels: GatewayAdminModelUsageRow[];
  };
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

export interface GatewayAdminChannel {
  id: string;
  transport: 'discord';
  guildId: string;
  channelId: string;
  defaultMode: 'off' | 'mention' | 'free';
  config: RuntimeDiscordChannelConfig;
}

export interface GatewayAdminChannelsResponse {
  groupPolicy: RuntimeConfig['discord']['groupPolicy'];
  defaultTypingMode: RuntimeConfig['discord']['typingMode'];
  defaultDebounceMs: number;
  defaultAckReaction: string;
  defaultRateLimitPerUser: number;
  defaultMaxConcurrentPerChannel: number;
  channels: GatewayAdminChannel[];
}

export interface GatewayAdminChannelUpsertRequest {
  guildId: string;
  channelId: string;
  config: RuntimeDiscordChannelConfig;
}

export interface GatewayAdminConfigResponse {
  path: string;
  config: RuntimeConfig;
}

export interface GatewayAdminModelCatalogEntry {
  id: string;
  configuredInHybridai: boolean;
  configuredInCodex: boolean;
  discovered: boolean;
  backend: 'ollama' | 'lmstudio' | 'vllm' | null;
  contextWindow: number | null;
  maxTokens: number | null;
  isReasoning: boolean;
  thinkingFormat: string | null;
  family: string | null;
  parameterSize: string | null;
  usageDaily: GatewayAdminUsageSummary | null;
  usageMonthly: GatewayAdminUsageSummary | null;
}

export interface GatewayAdminModelsResponse {
  defaultModel: string;
  hybridaiModels: string[];
  codexModels: string[];
  providerStatus: GatewayStatus['providerHealth'];
  models: GatewayAdminModelCatalogEntry[];
}

export interface GatewayAdminSchedulerJob {
  id: string;
  source: 'config' | 'task';
  name: string;
  description: string | null;
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

export interface GatewayAdminSkill {
  name: string;
  description: string;
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
  skills: GatewayAdminSkill[];
}

export interface GatewayAdminToolCatalogEntry {
  name: string;
  group: string;
  kind: 'builtin' | 'mcp' | 'other';
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
  return `${result.title}\n${result.text}`;
}
