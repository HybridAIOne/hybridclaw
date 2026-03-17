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
    jobs: Array<{
      id: string;
      name: string;
      description: string | null;
      enabled: boolean;
      lastRun: string | null;
      lastStatus: 'success' | 'error' | null;
      nextRunAt: string | null;
      disabled: boolean;
      consecutiveErrors: number;
    }>;
  };
  providerHealth?: Record<
    string,
    {
      kind: 'local' | 'remote';
      reachable: boolean;
      latencyMs?: number;
      error?: string;
      modelCount?: number;
      detail?: string;
    }
  >;
  localBackends?: Record<
    string,
    {
      reachable: boolean;
      latencyMs: number;
      error?: string;
      modelCount?: number;
    }
  >;
}

export interface AdminSession {
  id: string;
  guildId: string | null;
  channelId: string;
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

export interface AdminUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  callCount: number;
  totalToolCalls: number;
}

export interface AdminModelUsageRow extends AdminUsageSummary {
  model: string;
}

export interface AdminOverview {
  status: GatewayStatus;
  configPath: string;
  recentSessions: AdminSession[];
  usage: {
    daily: AdminUsageSummary;
    monthly: AdminUsageSummary;
    topModels: AdminModelUsageRow[];
  };
}

export interface AdminDiscordChannelConfig {
  mode: 'off' | 'mention' | 'free';
  typingMode?: 'instant' | 'thinking' | 'streaming' | 'never';
  debounceMs?: number;
  ackReaction?: string;
  ackReactionScope?: 'all' | 'group-mentions' | 'direct' | 'off';
  removeAckAfterReply?: boolean;
  humanDelay?: {
    mode: 'off' | 'natural' | 'custom';
    minMs: number;
    maxMs: number;
  };
  rateLimitPerUser?: number;
  suppressPatterns?: string[];
  maxConcurrentPerChannel?: number;
  allowSend?: boolean;
  sendAllowedUserIds?: string[];
  sendAllowedRoleIds?: string[];
}

export interface AdminMSTeamsChannelConfig {
  requireMention?: boolean;
  replyStyle?: 'thread' | 'top-level';
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  allowFrom?: string[];
  tools?: string[];
}

export type AdminChannelConfig =
  | AdminDiscordChannelConfig
  | AdminMSTeamsChannelConfig;

export type AdminChannelTransport = 'discord' | 'msteams';

export type AdminChannelEntry =
  | {
      id: string;
      transport: 'discord';
      guildId: string;
      channelId: string;
      defaultMode: 'off' | 'mention' | 'free';
      config: AdminDiscordChannelConfig;
    }
  | {
      id: string;
      transport: 'msteams';
      guildId: string;
      channelId: string;
      defaultGroupPolicy: 'open' | 'allowlist' | 'disabled';
      defaultReplyStyle: 'thread' | 'top-level';
      defaultRequireMention: boolean;
      config: AdminMSTeamsChannelConfig;
    };

export interface AdminChannelsResponse {
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  defaultTypingMode: 'instant' | 'thinking' | 'streaming' | 'never';
  defaultDebounceMs: number;
  defaultAckReaction: string;
  defaultRateLimitPerUser: number;
  defaultMaxConcurrentPerChannel: number;
  msteams: {
    enabled: boolean;
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    defaultRequireMention: boolean;
    defaultReplyStyle: 'thread' | 'top-level';
  };
  channels: AdminChannelEntry[];
}

export interface AdminConfig {
  version: number;
  hybridai: {
    baseUrl: string;
    defaultModel: string;
    defaultChatbotId: string;
    maxTokens: number;
    enableRag: boolean;
    models: string[];
  };
  discord: {
    prefix: string;
    respondToAllMessages: boolean;
    commandsOnly: boolean;
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    typingMode: 'instant' | 'thinking' | 'streaming' | 'never';
    debounceMs: number;
    ackReaction: string;
    rateLimitPerUser: number;
    maxConcurrentPerChannel: number;
    guilds: Record<
      string,
      {
        defaultMode: 'off' | 'mention' | 'free';
        channels: Record<string, AdminChannelConfig>;
      }
    >;
  };
  container: {
    sandboxMode: 'container' | 'host';
    image: string;
    memory: string;
    memorySwap: string;
    cpus: string;
    network: string;
    timeoutMs: number;
    binds: string[];
    additionalMounts: string;
    maxOutputBytes: number;
    maxConcurrent: number;
  };
  ops: {
    healthHost: string;
    healthPort: number;
    webApiToken: string;
    gatewayBaseUrl: string;
    gatewayApiToken: string;
    dbPath: string;
    logLevel: string;
  };
  [key: string]: unknown;
}

export interface AdminConfigResponse {
  path: string;
  config: AdminConfig;
}

export interface AdminModelCatalogEntry {
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
  usageDaily: AdminUsageSummary | null;
  usageMonthly: AdminUsageSummary | null;
}

export interface AdminModelsResponse {
  defaultModel: string;
  hybridaiModels: string[];
  codexModels: string[];
  providerStatus: GatewayStatus['providerHealth'];
  models: AdminModelCatalogEntry[];
}

export interface AdminSchedulerJob {
  id: string;
  source: 'config' | 'task';
  name: string;
  description: string | null;
  enabled: boolean;
  schedule: {
    kind: 'at' | 'every' | 'cron';
    at: string | null;
    everyMs: number | null;
    expr: string | null;
    tz: string;
  };
  action: {
    kind: 'agent_turn' | 'system_event';
    message: string;
  };
  delivery: {
    kind: 'channel' | 'last-channel' | 'webhook';
    channel: string;
    to: string;
    webhookUrl: string;
  };
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

export interface AdminSchedulerResponse {
  jobs: AdminSchedulerJob[];
}

export interface AdminMcpConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface AdminMcpServer {
  name: string;
  enabled: boolean;
  summary: string;
  config: AdminMcpConfig;
}

export interface AdminMcpResponse {
  servers: AdminMcpServer[];
}

export interface AdminAuditEntry {
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

export interface AdminAuditResponse {
  query: string;
  sessionId: string;
  eventType: string;
  limit: number;
  entries: AdminAuditEntry[];
}

export interface AdminSkill {
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

export interface AdminSkillsResponse {
  extraDirs: string[];
  disabled: string[];
  skills: AdminSkill[];
}

export interface AdminAdaptiveSkillErrorCluster {
  category: string;
  count: number;
  sample_detail?: string | null;
}

export interface AdminAdaptiveSkillHealthMetric {
  skill_name: string;
  total_executions: number;
  success_rate: number;
  avg_duration_ms: number;
  error_clusters: AdminAdaptiveSkillErrorCluster[];
  tool_breakage_rate: number;
  positive_feedback_count: number;
  negative_feedback_count: number;
  degraded: boolean;
  degradation_reasons: string[];
  window_started_at: string;
  window_ended_at: string;
}

export interface AdminAdaptiveSkillHealthResponse {
  metrics: AdminAdaptiveSkillHealthMetric[];
}

export interface AdminAdaptiveSkillAmendment {
  id: number;
  skill_name: string;
  skill_file_path: string;
  version: number;
  previous_version: number | null;
  status: 'staged' | 'applied' | 'rolled_back' | 'rejected';
  rationale: string;
  diff_summary: string;
  proposed_by: string;
  reviewed_by: string | null;
  guard_verdict: 'safe' | 'caution' | 'dangerous';
  guard_findings_count: number;
  runs_since_apply: number;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  rolled_back_at: string | null;
  rejected_at: string | null;
}

export interface AdminAdaptiveSkillAmendmentsResponse {
  amendments: AdminAdaptiveSkillAmendment[];
}

export interface AdminToolCatalogEntry {
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

export interface AdminToolGroup {
  label: string;
  tools: AdminToolCatalogEntry[];
}

export interface AdminToolExecution {
  id: number;
  toolName: string;
  sessionId: string;
  timestamp: string;
  durationMs: number | null;
  isError: boolean;
  summary: string | null;
}

export interface AdminToolsResponse {
  totals: {
    totalTools: number;
    builtinTools: number;
    mcpTools: number;
    otherTools: number;
    recentExecutions: number;
    recentErrors: number;
  };
  groups: AdminToolGroup[];
  recentExecutions: AdminToolExecution[];
}

export interface AdminWorkflowTrigger {
  kind: 'schedule' | 'channel_event' | 'reaction' | 'keyword' | 'webhook';
  cronExpr?: string;
  runAt?: string;
  everyMs?: number;
  sourceChannel?: string;
  eventType?: string;
  fromPattern?: string;
  contentPattern?: string;
  reactionEmoji?: string;
  subjectPattern?: string;
}

export interface AdminWorkflowDelivery {
  kind: 'channel' | 'email' | 'webhook' | 'originating';
  channelType?: string;
  target?: string;
  channelName?: string;
}

export interface AdminWorkflowRetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
  strategy?: 'fixed' | 'exponential';
  retryOn?: Array<'timeout' | 'delivery_error' | 'rate_limit' | 'transient'>;
}

export interface AdminWorkflowStep {
  id: string;
  kind: 'agent' | 'deliver' | 'approval';
  prompt?: string;
  input?: string;
  delivery?: AdminWorkflowDelivery;
  approvalPrompt?: string;
  dependsOn?: string[];
  deliverTo?: AdminWorkflowDelivery;
  extractAs?: string;
  timeoutMs?: number;
  retryPolicy?: AdminWorkflowRetryPolicy;
  lightContext?: boolean;
}

export interface AdminWorkflowSpec {
  version: 2;
  trigger: AdminWorkflowTrigger;
  steps: AdminWorkflowStep[];
  delivery: AdminWorkflowDelivery;
  defaults?: {
    timeoutMs?: number;
    retryPolicy?: AdminWorkflowRetryPolicy;
    lightContext?: boolean;
  };
  context?: Record<string, string>;
}

export interface AdminWorkflow {
  id: number;
  sessionId: string;
  agentId: string;
  channelId: string;
  name: string;
  description: string;
  naturalLanguage: string;
  spec: AdminWorkflowSpec;
  enabled: boolean;
  companionTaskId: number | null;
  lastRun: string | null;
  lastStatus: 'success' | 'error' | 'partial' | null;
  consecutiveErrors: number;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminWorkflowsResponse {
  workflows: AdminWorkflow[];
}

export interface DeleteSessionResult {
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
