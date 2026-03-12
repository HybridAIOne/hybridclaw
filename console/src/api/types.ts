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

export interface AdminChannelConfig {
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

export interface AdminChannelsResponse {
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  defaultTypingMode: 'instant' | 'thinking' | 'streaming' | 'never';
  defaultDebounceMs: number;
  defaultAckReaction: string;
  defaultRateLimitPerUser: number;
  defaultMaxConcurrentPerChannel: number;
  channels: Array<{
    id: string;
    transport: 'discord';
    guildId: string;
    channelId: string;
    defaultMode: 'off' | 'mention' | 'free';
    config: AdminChannelConfig;
  }>;
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
