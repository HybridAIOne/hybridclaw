export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AdminConfigReloadResponse {
  status: string;
  message?: string;
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
  imageTag: string | null;
  uptime: number;
  sessions: number;
  activeContainers: number;
  defaultAgentId: string;
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
  hybridai?: {
    apiKeyConfigured: boolean;
    apiKeySource: 'env' | 'runtime-secrets' | null;
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
  slackWebhook?: {
    targetCount: number;
    defaultTargetConfigured: boolean;
    lastReachabilityResults: Array<{
      target: string;
      ok: boolean;
      at: string;
      statusCode: number | null;
      error: string | null;
    }>;
    lastSendResults: Array<{
      target: string;
      ok: boolean;
      at: string;
      statusCode: number | null;
      error: string | null;
    }>;
  };
  discordWebhook?: {
    targetCount: number;
    defaultTargetConfigured: boolean;
    lastReachabilityResults: Array<{
      target: string;
      ok: boolean;
      at: string;
      statusCode: number | null;
      error: string | null;
    }>;
    lastSendResults: Array<{
      target: string;
      ok: boolean;
      at: string;
      statusCode: number | null;
      error: string | null;
    }>;
  };
  telegram?: {
    tokenConfigured: boolean;
    tokenSource: 'config' | 'env' | 'runtime-secrets' | null;
  };
  threema?: {
    secretConfigured: boolean;
    secretSource: 'config' | 'env' | 'runtime-secrets' | null;
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
  email?: {
    passwordConfigured: boolean;
    passwordSource: 'config' | 'env' | 'runtime-secrets' | null;
  };
  emailEnabled?: boolean;
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
    pairingError: string | null;
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
      loginRequired?: boolean;
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

export interface AdminEmailFolder {
  path: string;
  name: string;
  specialUse: string | null;
  total: number;
  unseen: number;
}

export interface AdminEmailMessageSummary {
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

export interface AdminEmailParticipant {
  name: string | null;
  address: string | null;
}

export interface AdminEmailAttachment {
  filename: string | null;
  contentType: string | null;
  size: number | null;
}

export interface AdminEmailMessageMetadata {
  agentId: string | null;
  model: string | null;
  provider: string | null;
  totalTokens: number | null;
  tokenSource: 'api' | 'estimated' | null;
}

export interface AdminEmailMessageDetail extends AdminEmailMessageSummary {
  to: AdminEmailParticipant[];
  cc: AdminEmailParticipant[];
  bcc: AdminEmailParticipant[];
  replyTo: AdminEmailParticipant[];
  text: string | null;
  attachments: AdminEmailAttachment[];
  metadata: AdminEmailMessageMetadata | null;
}

export interface AdminEmailMailboxResponse {
  enabled: boolean;
  address: string;
  folders: AdminEmailFolder[];
  defaultFolder: string | null;
}

export interface AdminEmailFolderResponse {
  folder: string;
  offset: number;
  limit: number;
  previousOffset: number | null;
  nextOffset: number | null;
  messages: AdminEmailMessageSummary[];
}

export interface AdminEmailMessageResponse {
  message: AdminEmailMessageDetail | null;
  thread: AdminEmailMessageDetail[];
}

export interface AdminEmailDeleteResponse {
  deleted: true;
  targetFolder: string | null;
  permanent: boolean;
}

export interface GatewayHistoryMessage {
  id: number;
  session_id: string;
  user_id: string;
  username: string | null;
  role: string;
  content: string;
  artifacts?: Array<{
    path: string;
    filename: string;
    mimeType: string;
  }>;
  created_at: string;
}

export interface GatewayHistoryResponse {
  sessionId: string;
  history: GatewayHistoryMessage[];
}

export interface AdminTerminalStartResponse {
  sessionId: string;
  websocketPath: string;
}

export interface AdminTerminalStopResponse {
  stopped: boolean;
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

export type AdminTunnelHealth = 'healthy' | 'reconnecting' | 'down';

export type AdminTunnelProvider =
  | 'cloudflare'
  | 'manual'
  | 'ngrok'
  | 'ssh'
  | 'tailscale';

export interface AdminTunnelConfig {
  mode: 'cloud' | 'local';
  provider: AdminTunnelProvider | (string & {}) | null;
  publicUrl: string;
  healthCheckIntervalMs: number;
}

export interface AdminTunnelConfigInput {
  provider: AdminTunnelProvider;
  publicUrl: string;
}

export interface AdminTunnelConfigResponse {
  config: AdminTunnelConfig;
  tunnel: AdminTunnelStatus;
}

export interface AdminTunnelStatus {
  provider: string | null;
  publicUrl: string | null;
  state: 'down' | 'starting' | 'up' | 'reconnecting';
  health: AdminTunnelHealth;
  reconnectSupported: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
  nextReconnectAt: string | null;
}

export interface AdminOverview {
  status: GatewayStatus;
  configPath: string;
  tunnel: AdminTunnelStatus;
  recentSessions: AdminSession[];
  usage: {
    daily: AdminUsageSummary;
    monthly: AdminUsageSummary;
    topModels: AdminModelUsageRow[];
  };
}

export interface AdminStatisticsTrendDay {
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

export interface AdminStatisticsChannelRow {
  channelId: string;
  sessionCount: number;
  userMessages: number;
  assistantMessages: number;
  totalMessages: number;
}

export interface AdminStatisticsResponse {
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
  trend: AdminStatisticsTrendDay[];
  channels: AdminStatisticsChannelRow[];
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
  slack: {
    enabled: boolean;
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    defaultRequireMention: boolean;
    defaultReplyStyle: 'thread' | 'top-level';
  };
  slackWebhook: {
    enabled: boolean;
    targetCount: number;
    defaultTargetConfigured: boolean;
  };
  discordWebhook: {
    enabled: boolean;
    targetCount: number;
    defaultTargetConfigured: boolean;
  };
  msteams: {
    enabled: boolean;
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    defaultRequireMention: boolean;
    defaultReplyStyle: 'thread' | 'top-level';
  };
  channels: AdminChannelEntry[];
}

export interface AdminStoredSecretRef {
  source: 'store';
  id: string;
}

export interface AdminEmailAccountConfig {
  agentId: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  address: string;
  password?: string | AdminStoredSecretRef;
  pollIntervalMs: number;
  folders: string[];
  allowFrom: string[];
  mediaMaxMb: number;
}

export interface AdminConfig {
  version: number;
  security: {
    trustModelAccepted: boolean;
    trustModelAcceptedAt: string;
    trustModelVersion: string;
    trustModelAcceptedBy: string;
    confidentialRedactionEnabled: boolean;
  };
  hybridai: {
    baseUrl: string;
    defaultModel: string;
    defaultChatbotId: string;
    maxTokens: number;
    enableRag: boolean;
    models: string[];
  };
  channelInstructions: {
    discord: string;
    discord_webhook: string;
    msteams: string;
    slack: string;
    slack_webhook: string;
    signal: string;
    telegram: string;
    threema: string;
    voice: string;
    whatsapp: string;
    email: string;
    imessage: string;
  };
  discord: {
    prefix: string;
    guildMembersIntent: boolean;
    presenceIntent: boolean;
    commandsOnly: boolean;
    commandMode: 'public' | 'restricted';
    commandAllowedUserIds: string[];
    commandUserId: string;
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    sendPolicy: 'open' | 'allowlist' | 'disabled';
    sendAllowedChannelIds: string[];
    freeResponseChannels: string[];
    textChunkLimit: number;
    maxLinesPerMessage: number;
    humanDelay: {
      mode: 'off' | 'natural' | 'custom';
      minMs: number;
      maxMs: number;
    };
    typingMode: 'instant' | 'thinking' | 'streaming' | 'never';
    presence: {
      enabled: boolean;
      intervalMs: number;
      healthyText: string;
      degradedText: string;
      exhaustedText: string;
      activityType:
        | 'playing'
        | 'watching'
        | 'listening'
        | 'competing'
        | 'custom';
    };
    lifecycleReactions: {
      enabled: boolean;
      removeOnComplete: boolean;
      phases: {
        queued: string;
        thinking: string;
        toolUse: string;
        streaming: string;
        done: string;
        error: string;
      };
    };
    debounceMs: number;
    ackReaction: string;
    ackReactionScope: 'all' | 'group-mentions' | 'direct' | 'off';
    removeAckAfterReply: boolean;
    rateLimitPerUser: number;
    rateLimitExemptRoles: string[];
    suppressPatterns: string[];
    maxConcurrentPerChannel: number;
    guilds: Record<
      string,
      {
        defaultMode: 'off' | 'mention' | 'free';
        channels: Record<string, AdminChannelConfig>;
      }
    >;
  };
  msteams: {
    enabled: boolean;
    appId: string;
    tenantId: string;
    webhook: {
      port: number;
      path: string;
    };
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    teams: Record<
      string,
      {
        requireMention?: boolean;
        tools?: string[];
        replyStyle?: 'thread' | 'top-level';
        groupPolicy?: 'open' | 'allowlist' | 'disabled';
        allowFrom?: string[];
        channels: Record<string, AdminMSTeamsChannelConfig>;
      }
    >;
    requireMention: boolean;
    textChunkLimit: number;
    replyStyle: 'thread' | 'top-level';
    mediaMaxMb: number;
    dangerouslyAllowNameMatching: boolean;
    mediaAllowHosts: string[];
    mediaAuthAllowHosts: string[];
  };
  slack: {
    enabled: boolean;
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    requireMention: boolean;
    textChunkLimit: number;
    replyStyle: 'thread' | 'top-level';
    mediaMaxMb: number;
  };
  slackWebhook: {
    enabled: boolean;
    webhooks: Record<
      string,
      {
        webhookUrl: string;
        defaultUsername: string;
        defaultIconEmoji: string;
        defaultIconUrl: string;
      }
    >;
  };
  discordWebhook: {
    enabled: boolean;
    webhooks: Record<
      string,
      {
        webhookUrl: string;
        defaultUsername: string;
        defaultAvatarUrl: string;
      }
    >;
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    pollIntervalMs: number;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    requireMention: boolean;
    textChunkLimit: number;
    mediaMaxMb: number;
  };
  signal: {
    enabled: boolean;
    daemonUrl: string;
    account: string;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    textChunkLimit: number;
    reconnectIntervalMs: number;
    outboundDelayMs: number;
  };
  threema: {
    enabled: boolean;
    apiBaseUrl: string;
    identity: string;
    secret: string;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    textChunkLimit: number;
    outboundDelayMs: number;
  };
  voice: {
    enabled: boolean;
    provider: 'twilio';
    twilio: {
      accountSid: string;
      authToken: string;
      fromNumber: string;
    };
    relay: {
      ttsProvider: 'default' | 'google' | 'amazon';
      voice: string;
      transcriptionProvider: 'default' | 'deepgram' | 'google';
      language: string;
      interruptible: boolean;
      welcomeGreeting: string;
    };
    webhookPath: string;
    maxConcurrentCalls: number;
  };
  whatsapp: {
    dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    textChunkLimit: number;
    debounceMs: number;
    sendReadReceipts: boolean;
    ackReaction: string;
    mediaMaxMb: number;
  };
  imessage: {
    enabled: boolean;
    backend: 'local' | 'bluebubbles';
    cliPath: string;
    dbPath: string;
    pollIntervalMs: number;
    serverUrl: string;
    password: string;
    webhookPath: string;
    allowPrivateNetwork: boolean;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    textChunkLimit: number;
    debounceMs: number;
    mediaMaxMb: number;
  };
  email: {
    enabled: boolean;
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    address: string;
    password: string;
    pollIntervalMs: number;
    folders: string[];
    allowFrom: string[];
    textChunkLimit: number;
    mediaMaxMb: number;
    accounts?: AdminEmailAccountConfig[];
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
    persistBashState: boolean;
  };
  browser?: {
    provider:
      | 'local'
      | 'camofox'
      | 'managed-cloud'
      | 'browser-use-cloud'
      | 'mac-cua';
    allowPrivateNetwork: boolean;
    local: {
      profileDir: string;
      headed: boolean;
    };
    camofox: {
      profileDir: string;
      headed: boolean;
    };
    managedCloud: {
      endpointUrl: string;
      poolTokenRef:
        | {
            source: 'store';
            id: string;
          }
        | undefined;
      defaultTenantId: string;
      pricing: {
        actionUsd: number;
      };
    };
    browserUseCloud: {
      apiKeyRef:
        | {
            source: 'store';
            id: string;
          }
        | undefined;
      projectId: string;
      profileId: string;
      region: string;
      keepAlive: boolean;
      pricing: {
        browserUsdPerMinute: number;
        actionUsd: number;
      };
    };
    macCua: {
      browser: 'safari' | 'chrome' | 'firefox' | 'brave' | 'arc';
      driverCommand: string;
      driverArgs: string[];
      screenshotMode: 'som' | 'vision' | 'ax';
    };
  };
  deployment: {
    mode: 'cloud' | 'local';
    public_url: string;
    tunnel: {
      provider?:
        | 'cloudflare'
        | 'manual'
        | 'ngrok'
        | 'ssh'
        | 'tailscale'
        | (string & {});
      health_check_interval_ms: number;
    };
  };
  ui?: {
    navigation: Array<{
      label: string;
      href: string;
      icon?: 'admin' | 'agents' | 'chat' | 'docs';
      image?: string;
    }>;
  };
  ops: {
    healthHost: string;
    healthPort: number;
    webApiToken: string;
    gatewayBaseUrl: string;
    gatewayInternalBaseUrl: string;
    gatewayApiToken: string;
    dbPath: string;
    logLevel: LogLevel;
    logRequests?: boolean;
    debugModelResponses?: boolean;
  };
  [key: string]: unknown;
}

export interface AdminConfigResponse {
  path: string;
  config: AdminConfig;
}

export interface AdminLogFile {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  readable: boolean;
  sizeBytes: number | null;
  mtime: string | null;
  description: string;
  error: string | null;
}

export interface AdminLogTail {
  fileId: string;
  content: string;
  tailBytes: number;
  truncated: boolean;
}

export interface AdminLoggingState {
  configuredLevel: LogLevel;
  effectiveLevel: LogLevel;
  forcedLevel: LogLevel | null;
  logRequests: {
    configured: boolean;
    envEnabled: boolean;
    effective: boolean;
  };
  debugModelResponses: {
    configured: boolean;
    envEnabled: boolean;
    effective: boolean;
  };
}

export interface AdminLogsResponse {
  files: AdminLogFile[];
  selected: AdminLogTail | null;
  logging?: AdminLoggingState;
}

export interface AdminBrowserPoolHealthResponse {
  ok: boolean;
  status: 'online' | 'offline' | 'disabled';
  endpointUrl: string;
  nodeCount: number;
  healthyNodeCount: number;
  message: string;
}

export interface AdminBrowserPoolLaunchResponse {
  ok: boolean;
  status: 'started' | 'starting' | 'already-running' | 'unsupported' | 'failed';
  endpointUrl: string;
  pid: number | null;
  message: string;
  poolTokenRefId?: string;
  logTail?: string;
}

export interface SignalLinkResponse {
  status: 'idle' | 'starting' | 'qr' | 'complete' | 'error';
  pairingQrText: string | null;
  pairingUri: string | null;
  updatedAt: string | null;
  error: string | null;
}

export interface AdminCommandResult {
  kind: 'plain' | 'info' | 'error';
  title?: string;
  text: string;
  sessionId?: string;
  sessionKey?: string;
  mainSessionKey?: string;
}

/** Minimum fields the chat surface needs to render and switch between models. */
export interface ChatModel {
  id: string;
  /** Gateway provider key (matches `GatewayStatus.providerHealth` keys). */
  provider: string;
  backend: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'browser' | null;
  contextWindow: number | null;
  isReasoning: boolean;
  family: string | null;
  parameterSize: string | null;
}

export interface AdminModelCatalogEntry extends ChatModel {
  discovered: boolean;
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
  thinkingFormat: string | null;
  usageDaily: AdminUsageSummary | null;
  usageMonthly: AdminUsageSummary | null;
}

export interface AdminModelsResponse {
  defaultModel: string;
  auxiliaryModels?: {
    skillsHub: {
      provider:
        | 'auto'
        | 'disabled'
        | 'hybridai'
        | 'openai-codex'
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
        | 'vllm'
        | 'browser';
      model: string | null;
    };
  };
  providerStatus: GatewayStatus['providerHealth'];
  models: AdminModelCatalogEntry[];
}

export interface AdminBrowserModelBridgeStatus {
  running: boolean;
  host: string;
  port: number;
  model: string;
  pageUrl: string;
  endpointUrl: string;
  configuredModel: string;
  configuredDefault: boolean;
}

export interface AdminBrowserModelBridgeStartRequest {
  model: string;
  host: string;
  port: number;
  device: string;
  dtype: string;
  apiKey?: string;
  maxNewTokens: number;
  setDefault: boolean;
}

export interface AdminBrowserModelBridgeResponse {
  bridge: AdminBrowserModelBridgeStatus;
  models: AdminModelsResponse;
}

export type AdminSchedulerBoardStatus =
  | 'backlog'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled';

export interface AdminSchedulerJob {
  id: string;
  source: 'job' | 'task';
  name: string;
  description: string | null;
  agentId: string | null;
  boardStatus: AdminSchedulerBoardStatus | null;
  maxRetries: number | null;
  enabled: boolean;
  schedule: {
    kind: 'at' | 'every' | 'cron' | 'one_shot';
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

export interface AdminAgentMarkdownFile {
  name: string;
  displayName?: string;
  path: string;
  scope?: 'agent' | 'installation' | 'company';
  cloudPath?: string;
  readOnly?: boolean;
  exists: boolean;
  updatedAt: string | null;
  sizeBytes: number | null;
}

export interface AdminAgentMarkdownRevision {
  id: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  source: 'save' | 'restore';
}

export type AdminAgentProxyConversationScope = 'channel' | 'user';

export interface AdminAgentProxyConfig {
  kind: 'hybridai';
  baseUrl: string;
  chatbotId: string;
  apiKey: {
    source: 'store';
    id: string;
  };
  conversationScope?: AdminAgentProxyConversationScope;
}

export interface AdminAgent {
  id: string;
  name: string | null;
  emptyChatHeader?: string | null;
  model: string | null;
  skills: string[] | null;
  chatbotId: string | null;
  enableRag: boolean | null;
  proxy?: AdminAgentProxyConfig | null;
  role: string | null;
  reportsTo: string | null;
  delegatesTo: string[] | null;
  peers: string[] | null;
  workspace: string | null;
  workspacePath: string;
  markdownFiles: AdminAgentMarkdownFile[];
}

export interface AdminAgentsResponse {
  agents: AdminAgent[];
}

export interface AdminHybridAIBot {
  id: string;
  name: string;
  description?: string;
  model?: string;
}

export interface AdminHybridAIBotsResponse {
  bots: AdminHybridAIBot[];
}

export interface AdminTeamStructureEntry {
  id: string;
  role?: string;
  reportsTo?: string;
  delegatesTo?: string[];
  peers?: string[];
}

export interface AdminTeamStructureSnapshot {
  version: 1;
  agents: AdminTeamStructureEntry[];
}

export interface AdminTeamStructureFieldDiff {
  field: 'role' | 'reportsTo' | 'delegatesTo' | 'peers';
  before: string | string[] | null;
  after: string | string[] | null;
}

export interface AdminTeamStructureAgentDiff {
  agentId: string;
  fields: AdminTeamStructureFieldDiff[];
}

export interface AdminTeamStructureDiff {
  added: AdminTeamStructureEntry[];
  removed: AdminTeamStructureEntry[];
  changed: AdminTeamStructureAgentDiff[];
}

export interface AdminTeamStructureRevision {
  id: number;
  createdAt: string;
  actor: string;
  route: string;
  source: string;
  md5: string;
  sizeBytes: number;
  replacedByMd5: string | null;
  changeCount: number;
  diff: AdminTeamStructureDiff;
}

export interface AdminTeamStructureResponse {
  snapshot: AdminTeamStructureSnapshot;
  revisions: AdminTeamStructureRevision[];
}

export interface AdminTeamStructureRevisionResponse {
  revision: AdminTeamStructureRevision;
}

export interface AdminAgentMarkdownFileResponse {
  agent: AdminAgent;
  file: AdminAgentMarkdownFile & {
    content: string;
    revisions: AdminAgentMarkdownRevision[];
  };
}

export interface AdminAgentMarkdownRevisionResponse {
  agent: AdminAgent;
  fileName: string;
  revision: AdminAgentMarkdownRevision & {
    content: string;
  };
}

export interface AgentCard {
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
  monthlySpendUsd: number;
}

export interface AgentSessionCard {
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

export interface AgentsOverviewResponse {
  generatedAt: string;
  version: string;
  uptime: number;
  ralph: {
    enabled: boolean;
    maxIterations: number;
  };
  totals: {
    agents: {
      all: number;
      active: number;
      idle: number;
      stopped: number;
      unused: number;
      running: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      totalCostUsd: number;
    };
    sessions: {
      all: number;
      active: number;
      idle: number;
      stopped: number;
      running: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      totalCostUsd: number;
    };
  };
  agents: AgentCard[];
  sessions: AgentSessionCard[];
}

export type AgentListItemSource =
  | { type: 'local' }
  | {
      type: 'remote';
      peerId: string;
      instanceId: string;
    };

export interface AgentListItem {
  id: string;
  name: string | null;
  imageUrl?: string | null;
  emptyChatHeader?: string | null;
  source?: AgentListItemSource;
}

export interface RemoteAgentListPeer {
  peerId: string;
  instanceId: string;
  agentCardUrl: string;
  agents: AgentListItem[];
}

export interface AgentListResponse {
  agents: AgentListItem[];
  remotePeers?: RemoteAgentListPeer[];
}

export interface JobAgent {
  id: string;
  name: string | null;
}

export interface JobSession {
  sessionId: string;
  agentId: string;
  startedAt: string;
  lastActive: string;
  status: 'active' | 'idle' | 'stopped';
  lastAnswer: string | null;
  output: string[];
}

export interface AdminJobsContextResponse {
  agents: JobAgent[];
  cards: AdminJobCard[];
  sessions: JobSession[];
  suspendedSessions: AdminSuspendedSession[];
}

export type AdminJobCardColumn =
  | 'triage'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done';

export type AdminJobCardEdgeKind = 'blocks' | 'blocked_by' | 'related';

export interface AdminJobCardEdge {
  id: string;
  fromCardId: string;
  toCardId: string;
  kind: AdminJobCardEdgeKind;
  createdAt: string;
}

export interface AdminJobCard {
  id: string;
  title: string;
  body: string;
  owner: {
    type: 'agent' | 'user';
    id: string;
  };
  column: AdminJobCardColumn;
  status: string;
  source: string;
  parent: string | null;
  createdAt: string;
  updatedAt: string;
  blocked: boolean;
  edges: AdminJobCardEdge[];
}

export type AdminBoardBudgetCurrency = 'USD' | 'EUR';
// Keep in sync with AgentBudgetUnit in src/agents/agent-types.ts.
export type AdminBoardBudgetUnit = AdminBoardBudgetCurrency | 'tokens';

export interface AdminBoardBudgetSummary {
  agentId: string;
  used: number;
  cap: number;
  unit: AdminBoardBudgetUnit;
  currency: AdminBoardBudgetCurrency;
  percent: number;
}

export interface AdminBoardBudgetResponse {
  budgets: AdminBoardBudgetSummary[];
}

export interface AdminMcpConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: 'oauth';
  enabled?: boolean;
}

export type AdminMcpAuthState = 'connected' | 'expired' | 'unauthorized';

export interface AdminMcpAuthStatus {
  method: 'oauth' | 'none';
  state?: AdminMcpAuthState;
  expiresAt?: number | null;
  scope?: string;
}

export interface AdminMcpServer {
  name: string;
  enabled: boolean;
  summary: string;
  config: AdminMcpConfig;
  auth: AdminMcpAuthStatus;
}

export interface AdminMcpResponse {
  servers: AdminMcpServer[];
}

export interface AdminMcpOAuthStartResponse {
  serverName: string;
  authorizationUrl: string;
  state: string;
  expiresAt: number;
}

export interface AdminMcpOAuthStatusResponse {
  name: string;
  auth: AdminMcpAuthStatus;
}

export type AdminConnectorId =
  | 'hybridai'
  | 'github'
  | 'google'
  | 'microsoft365';

export type AdminConnectorState = 'connected' | 'not_connected' | 'needs_setup';

export interface AdminConnector {
  id: AdminConnectorId;
  name: string;
  description: string;
  state: AdminConnectorState;
  authKind: 'api-key' | 'oauth';
  account: string | null;
  detail: string;
  scopes: string[];
  routesConfigured: boolean;
  clientConfigured: boolean;
  clientSecretConfigured: boolean;
  tenantId: string | null;
  loginUrl: string | null;
  adminConsentUrl: string | null;
  setupSecretNames: string[];
}

export interface AdminConnectorsResponse {
  connectors: AdminConnector[];
  secretsPath: string;
}

export interface AdminConnectorOAuthStartResponse {
  provider: Exclude<AdminConnectorId, 'hybridai'>;
  authorizationUrl: string;
  state: string;
  expiresAt: number;
}

export interface AdminConnectorTestResponse {
  provider: AdminConnectorId;
  name: string;
  ok: boolean;
  message: string;
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
  since: string | null;
  until: string | null;
  limit: number;
  entries: AdminAuditEntry[];
  /** Opaque cursor for the next page; pass back as `cursor=`. null on the last page. */
  nextCursor: number | null;
  /** Total rows matching the filters in the database, independent of pagination. */
  total: number;
}

export interface AdminA2AIdentity {
  instanceId: string;
  publicKeyFingerprint: string;
  publicKeyJwk: JsonWebKey;
}

export interface AdminA2ATrustPeer {
  peerId: string;
  agentCardUrl: string;
  deliveryUrl: string;
  publicKeyFingerprint: string;
  publicKeyJwk: JsonWebKey | null;
  status: 'trusted' | 'revoked';
  trustedAt: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  lastMismatchAt: string | null;
  lastMismatchFingerprint: string | null;
}

export interface AdminA2ATrustResponse {
  identity: AdminA2AIdentity;
  peers: AdminA2ATrustPeer[];
  pairingRequests: AdminA2APairingRequest[];
}

export interface AdminA2ATrustUpsertRequest {
  peerId: string;
  agentCardUrl?: string;
  deliveryUrl?: string;
  publicKeyFingerprint?: string;
  publicKeyJwk?: JsonWebKey;
  reason?: string;
}

export interface AdminFleetTopologyHq {
  instanceId: string;
  publicKeyFingerprint: string;
  version: string;
  status: 'local';
  latencyMs: number;
  lastSeenAt: string;
}

export type AdminFleetTopologyInstanceStatus =
  | 'online'
  | 'unreachable'
  | 'unconfigured'
  | 'revoked';

export interface AdminFleetTopologyInstance {
  peerId: string;
  agentCardUrl: string;
  deliveryUrl: string;
  publicKeyFingerprint: string;
  trustStatus: 'trusted' | 'revoked';
  status: AdminFleetTopologyInstanceStatus;
  version: string | null;
  latencyMs: number | null;
  error: string | null;
  trustedAt: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface AdminFleetTopologyResponse {
  hq: AdminFleetTopologyHq;
  instances: AdminFleetTopologyInstance[];
}

export interface AdminFleetTopologyUpsertRequest {
  peerId: string;
  agentCardUrl?: string;
  deliveryUrl?: string;
  publicKeyFingerprint?: string;
  publicKeyJwk?: JsonWebKey;
  reason?: string;
}

export interface AdminA2APairingRequest {
  schemaVersion: 1;
  requestId: string;
  status: 'pending' | 'approved' | 'declined';
  pairingId: string | null;
  peerId: string;
  agentCardUrl: string;
  deliveryUrl: string;
  publicKeyJwk: JsonWebKey;
  publicKeyFingerprint: string;
  name: string | null;
  requestedBy: string | null;
  requestedAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  declinedAt?: string;
  declinedBy?: string;
  reason?: string;
}

export interface AdminA2APairingStartRequest {
  peerUrl?: string;
  canonicalId?: string;
  canonicalInstanceId?: string;
  reason?: string;
  notifyPeer?: boolean;
}

export interface AdminA2APairingPreviewResponse {
  proposal: {
    peerId: string;
    agentCardUrl: string;
    deliveryUrl: string;
    publicKeyFingerprint: string;
    publicKeyJwk: JsonWebKey;
    name: string | null;
  };
}

export interface AdminA2APairingStartResponse extends AdminA2ATrustResponse {
  proposal: {
    peerId: string;
    agentCardUrl: string;
    deliveryUrl: string;
    publicKeyFingerprint: string;
    name: string | null;
  };
  remoteNotification: {
    status: 'not_requested' | 'sent' | 'failed';
    url: string | null;
    error: string | null;
  };
}

export interface AdminA2AThreadMessage {
  id: string;
  threadId: string;
  senderAgentId: string;
  recipientAgentId: string;
  parentMessageId: string | null;
  intent: 'chat' | 'handoff' | 'escalate' | 'ack' | 'policy.update';
  content: string;
  createdAt: string;
}

export interface AdminA2AThreadSummary {
  id: string;
  ownerCoworkerId: string | null;
  messageCount: number;
  participants: string[];
  latestMessage: AdminA2AThreadMessage | null;
}

export interface AdminA2AInboxResponse {
  threads: AdminA2AThreadSummary[];
  selectedThreadId: string | null;
  messages: AdminA2AThreadMessage[];
}

export interface AdminApprovalAgent {
  id: string;
  name: string | null;
  workspacePath: string;
}

export interface AdminPendingApproval {
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

// Mirrors GatewayAdminSuspendedSession in src/gateway/gateway-types.ts.
export interface AdminSuspendedSession {
  sessionId: string;
  agentId: string | null;
  approvalId: string;
  userId: string;
  prompt: string;
  status: 'pending' | 'resumed' | 'declined' | 'timed_out' | 'expired';
  modality: 'totp' | 'push' | 'qr' | 'sms' | 'recovery_code';
  expectedReturnKinds: string[];
  context: {
    host?: string | null;
    pageTitle?: string | null;
    url?: string | null;
    screenshotRef?: string | null;
  };
  createdAt: string;
  expiresAt: string;
  blockedLabel: string;
}

export type AdminInteractionResponse =
  | { kind: 'code'; value: string }
  | { kind: 'approved' }
  | { kind: 'scanned' }
  | { kind: 'declined'; reason?: string }
  | { kind: 'timeout' };

export interface AdminInteractionResumeResponse {
  session: {
    sessionId: string;
    status: AdminSuspendedSession['status'];
    modality: AdminSuspendedSession['modality'];
  };
  response: AdminInteractionResponse;
}

export interface AdminPolicyRule {
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

export interface AdminPolicyRuleInput {
  action: 'allow' | 'deny';
  host: string;
  port: number | '*';
  methods: string[];
  paths: string[];
  agent: string;
  comment?: string;
}

export type AdminLanHttpAccessMode =
  | 'off'
  | 'read-only'
  | 'read-write'
  | 'custom';

export interface AdminLanHttpAccessState {
  mode: AdminLanHttpAccessMode;
  managedRuleIndexes: number[];
}

export interface AdminPolicyState {
  exists: boolean;
  policyPath: string;
  workspacePath: string;
  defaultAction: 'allow' | 'deny';
  presets: string[];
  rules: AdminPolicyRule[];
  lanHttpAccess: AdminLanHttpAccessState;
}

export interface AdminPolicyPresetSummary {
  name: string;
  description: string;
}

export interface AdminApprovalsResponse {
  selectedAgentId: string;
  agents: AdminApprovalAgent[];
  pending: AdminPendingApproval[];
  suspendedSessions: AdminSuspendedSession[];
  policy: AdminPolicyState;
  availablePresets: AdminPolicyPresetSummary[];
}

export interface AdminSkill {
  name: string;
  description: string;
  category: string;
  shortDescription?: string;
  logoUrl?: string;
  developer: string;
  source: string;
  available: boolean;
  enabled: boolean;
  blocked?: boolean;
  blockedReason?: string;
  guardFindings?: Array<{
    patternId: string;
    severity: string;
    category: string;
    file: string;
    line: number;
    description: string;
  }>;
  missing: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  always: boolean;
  capabilities: string[];
  supportedChannels: string[];
  requires: {
    bins: string[];
    env: string[];
  };
  tags: string[];
  relatedSkills: string[];
  install: Array<{
    id?: string;
    kind: 'brew' | 'uv' | 'npm' | 'node' | 'go' | 'download';
    label?: string;
    bins?: string[];
    formula?: string;
    package?: string;
    module?: string;
    url?: string;
    path?: string;
    chmod?: string;
  }>;
  credentials: Array<{
    id: string;
    kind: string;
    required: boolean;
    secretRef: {
      source: string;
      id: string;
    };
    scope?: string;
    howToObtain?: string;
  }>;
  configVariables: Array<{
    id: string;
    env: string;
    required: boolean;
    scope?: string;
    howToObtain?: string;
  }>;
  docs?: {
    title: string;
    sourcePath: string;
    sourceHref: string;
    tutorialMarkdown: string;
    screenshots: Array<{
      src: string;
      alt: string;
      title?: string;
    }>;
    examplePrompts: Array<{
      prompt: string;
      kind: 'try-it' | 'conversation';
      turnIndex?: number;
      conversationId?: string;
    }>;
  };
}

export type AdminSkillPackageEntryKind =
  | 'directory'
  | 'file'
  | 'symlink'
  | 'other';

export interface AdminSkillPackageFile {
  path: string;
  name: string;
  kind: AdminSkillPackageEntryKind;
  sizeBytes: number | null;
  updatedAt: string | null;
  editable: boolean;
  previewable: boolean;
}

export interface AdminSkillPackageFilesResponse {
  skillName: string;
  rootPath: string;
  files: AdminSkillPackageFile[];
}

export interface AdminSkillPackageFileResponse {
  skillName: string;
  rootPath: string;
  file: AdminSkillPackageFile & {
    content: string | null;
  };
}

export interface AdminSkillInvocation {
  sessionId: string;
  userMessageId: number;
  assistantMessageId: number | null;
  username: string | null;
  createdAt: string;
  responseCreatedAt: string | null;
  userPrompt: string;
  skillInput: string;
  response: string | null;
}

export interface AdminSkillInvocationsResponse {
  skillName: string;
  invocations: AdminSkillInvocation[];
}

export interface AdminSkillsResponse {
  extraDirs: string[];
  disabled: string[];
  channelDisabled?: Record<string, string[]>;
  skills: AdminSkill[];
}

export interface AdminCreateSkillFile {
  path: string;
  content: string;
}

export interface AdminCreateSkillPayload {
  name: string;
  description: string;
  category?: string;
  shortDescription?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  tags?: string[];
  body: string;
  files?: AdminCreateSkillFile[];
}

export interface AdminPlugin {
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

export interface AdminPluginsResponse {
  totals: {
    totalPlugins: number;
    enabledPlugins: number;
    failedPlugins: number;
    commands: number;
    tools: number;
    hooks: number;
  };
  plugins: AdminPlugin[];
}

export interface AdminOutputGuardProfile {
  enabled: boolean;
  mode: 'block' | 'rewrite' | 'flag';
  policy: string;
  doList: string[];
  dontList: string[];
  bannedPhrases: string[];
  bannedPatterns: string[];
  requirePhrases: string[];
  classifier: AdminOutputGuardModelConfig;
  rewriter: AdminOutputGuardModelConfig;
}

export interface AdminOutputGuardModelConfig {
  provider: 'default' | 'auxiliary' | 'model';
  model: string;
}

export interface AdminOutputGuardRevision {
  id: number;
  createdAt: string;
  actor: string;
  route: string;
  source: string;
  md5: string;
}

export interface AdminOutputGuardProfileResponse {
  profile: AdminOutputGuardProfile;
  revisions: AdminOutputGuardRevision[];
}

export interface AdminOutputGuardProfileUpdateResponse
  extends AdminOutputGuardProfileResponse {
  changed: boolean;
  reloadMessage: string;
}

export interface AdminOutputGuardPreviewViolation {
  kind: 'banned_phrase' | 'banned_pattern' | 'missing_required';
  detail: string;
}

export interface AdminOutputGuardPreviewClassifier {
  provider: 'default' | 'auxiliary' | 'model';
  status: 'evaluated' | 'unavailable' | 'unparseable';
  verdict: 'compliant' | 'non_compliant' | null;
  severity: 'low' | 'medium' | 'high' | null;
  reasons: string[];
  message: string | null;
  model: string | null;
}

export interface AdminOutputGuardPreviewResponse {
  score: number;
  ruleScore: number;
  scoreSource: 'classifier' | 'rules';
  verdict: 'compliant' | 'needs_review' | 'non_compliant';
  violations: AdminOutputGuardPreviewViolation[];
  classifier: AdminOutputGuardPreviewClassifier;
}

export interface AdminAdaptiveSkillErrorCluster {
  category: string;
  count: number;
  sample_detail?: string | null;
}

export interface AdminAdaptiveSkillHealthMetric {
  skill_name: string;
  total_executions: number;
  success_count: number;
  partial_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration_ms: number;
  error_clusters: AdminAdaptiveSkillErrorCluster[];
  tool_calls_attempted: number;
  tool_calls_failed: number;
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

export interface AdminAgentSkillScore {
  agent_id: string;
  skill_id: string;
  skill_name: string;
  total_executions: number;
  success_count: number;
  failure_count: number;
  partial_count: number;
  success_rate: number;
  avg_duration_ms: number;
  tool_breakage_rate: number;
  positive_feedback_count: number;
  negative_feedback_count: number;
  last_run_at: string | null;
  quality_score: number;
  reliability_score: number;
  timing_score: number;
  score: number;
  last_observed_at: string | null;
}

export interface AdminAgentScoreboardEntry {
  agent_id: string;
  display_name: string;
  total_executions: number;
  success_rate: number;
  avg_score: number;
  avg_quality_score: number;
  avg_reliability_score: number;
  avg_timing_score: number;
  best_skills: AdminAgentSkillScore[];
  last_observed_at: string | null;
  weekly_anomalies_flagged: number;
  weekly_anomalies_confirmed_normal: number;
  weekly_anomaly_summary: string;
}

export interface AdminAgentScoreboardResponse {
  observed_skill_count: number;
  agents: AdminAgentScoreboardEntry[];
}

export type AdminDistillStageName =
  | 'ingest'
  | 'analyse'
  | 'build'
  | 'merge'
  | 'correct';

export type AdminDistillStageStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'awaiting-extraction';

export type AdminDistillSourceKind =
  | 'auto'
  | 'slack-export'
  | 'email-mbox'
  | 'transcript'
  | 'chat-jsonl'
  | 'markdown'
  | 'text'
  | 'interview'
  | 'correction';

export interface AdminDistillStageState {
  status: AdminDistillStageStatus;
  startedAt?: string;
  completedAt?: string;
  detail?: string;
}

export interface AdminDistillSubjectProfile {
  version: 1;
  alias: string;
  displayName: string;
  realPerson: boolean;
  role?: string;
  relationship?: string;
  personalityTags: string[];
  matchAliases: string[];
  createdAt: string;
}

export interface AdminDistillConsentSummary {
  present: boolean;
  valid: boolean;
  revokedAt: string | null;
  recordedAt: string | null;
  grantedBy: string | null;
  method: string | null;
  scope: string | null;
  sha256: string | null;
}

export interface AdminDistillEmbeddedText {
  available: boolean;
  content: string;
  byteLength: number;
  truncated: boolean;
  error: string | null;
}

export interface AdminDistillRunSummary {
  runId: string;
  status: 'pending' | 'awaiting-extraction' | 'failed' | 'completed';
  createdAt: string;
  updatedAt: string;
  stages: Record<AdminDistillStageName, AdminDistillStageState>;
  stats: {
    documentsAdded: number;
    documentsTotal: number;
    deltaDocuments: number;
    claimsAdded: number;
    claimsFlagged: number;
    reviewsOpened: number;
  };
  sources: Array<{ path: string; kind: AdminDistillSourceKind }>;
  reportPath: string;
  packetMarkdownPath: string;
  extractionPath: string;
  artifacts: {
    report: AdminDistillEmbeddedText;
    packetMarkdown: AdminDistillEmbeddedText;
    extraction: AdminDistillEmbeddedText;
  };
}

export interface AdminDistillDataPaths {
  workspacePath: string;
  subjectPath: string;
  uploadsPath: string;
  corpusDocumentsPath: string;
}

export interface AdminDistillCorpusDocumentSummary {
  id: string;
  source: Exclude<AdminDistillSourceKind, 'auto'>;
  origin: string;
  author: string;
  authoredBySubject: boolean;
  title?: string;
  channel?: string;
  timestamp?: string;
  wordCount: number;
  weight: number;
  holdout: boolean;
  runId: string | null;
  contentPreview: AdminDistillEmbeddedText;
}

export interface AdminDistillSubjectSummary {
  agentId: string;
  alias: string;
  registeredAgent: boolean;
  profile: AdminDistillSubjectProfile;
  consent: AdminDistillConsentSummary;
  paths: AdminDistillDataPaths;
  corpusDocuments: number;
  corpus: AdminDistillCorpusDocumentSummary[];
  openReviews: number;
  runs: AdminDistillRunSummary[];
  latestRun: AdminDistillRunSummary | null;
}

export interface AdminDistillResponse {
  sourceKinds: AdminDistillSourceKind[];
  subjects: AdminDistillSubjectSummary[];
}

export interface AdminDistillSubjectPayload {
  agentId?: string;
  alias: string;
  displayName?: string;
  realPerson?: boolean;
  role?: string;
  relationship?: string;
  personalityTags?: string[];
  matchAliases?: string[];
}

export interface AdminDistillConsentPayload {
  agentId?: string;
  alias: string;
  subjectName?: string;
  grantedBy: string;
  method: string;
  statement: string;
  scope?: string;
  note?: string;
}

export interface AdminDistillRunPayload extends AdminDistillSubjectPayload {
  sources?: Array<{ path: string; kind: AdminDistillSourceKind }>;
  resumeRunId?: string;
  holdoutRatio?: number;
  kind?: AdminDistillSourceKind;
}

export interface AdminDistillSubjectResponse {
  subject: AdminDistillSubjectSummary;
}

export interface AdminDistillRunResponse {
  subject: AdminDistillSubjectSummary;
  run: AdminDistillRunSummary;
  warnings: string[];
  flagged: string[];
}

export interface AdminDistillUploadResponse {
  source: { path: string; kind: AdminDistillSourceKind };
  path: string;
  filename: string;
  sizeBytes: number;
  preview: AdminDistillEmbeddedText;
}

export interface AdminHarnessEvolutionMetrics {
  taskCount: number;
  rolloutCount: number;
  successCount: number;
  passAt1: number;
  succPerMtok: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface AdminHarnessEvolutionRound {
  round: number;
  metrics: AdminHarnessEvolutionMetrics;
  attributionScore: number;
  editsPerSurface: Record<string, number>;
  manifestPath: string;
  reportPath: string;
  evolveAgent: {
    source:
      | 'evolve_agent'
      | 'report_json'
      | 'provided_edits'
      | 'dry_run_skipped';
    editCount: number;
    outputPath: string | null;
    provider: string | null;
    model: string | null;
  };
  improvedBest: boolean;
  gitCommit: string | null;
}

export interface AdminHarnessEvolutionSeedDelta {
  mode: 'fresh_seed' | 'in_place';
  changedSurfaceCount: number;
  changedSurfaces: string[];
  fileCount: number;
  notes: string[];
}

export interface AdminHarnessEvolutionRun {
  runId: string;
  targetRoot: string;
  suite: {
    id: string;
    name: string;
    sourcePath: string;
    tasks: Array<{ id: string; skill?: string; command?: string }>;
    costBudgetUsd?: number;
    maxTokens?: number;
  };
  rounds: AdminHarnessEvolutionRound[];
  bestPassAt1: number;
  bestRound: number | null;
  costGate: {
    ok: boolean;
    totalCostUsd: number;
    budgetUsd: number | null;
    reason: string | null;
  };
  seedDelta: AdminHarnessEvolutionSeedDelta;
  summaryPath: string;
}

export interface AdminHarnessEvolutionRunListEntry {
  runId: string;
  targetRoot: string;
  suiteId: string;
  suiteName: string;
  roundCount: number;
  bestPassAt1: number;
  bestRound: number | null;
  totalCostUsd: number;
  seedDeltaMode: 'fresh_seed' | 'in_place';
  seedDeltaChangedSurfaceCount: number;
  summaryPath: string;
  createdAt: string;
}

export interface AdminHarnessEvolutionResponse {
  targetRoot: string;
  runs: AdminHarnessEvolutionRunListEntry[];
}

export interface AdminHarnessEvolutionRunResponse {
  run: AdminHarnessEvolutionRun;
}

export interface AdminHarnessEvolutionManifestEntry {
  id: string;
  round: number;
  surface: string;
  path: string;
  prediction: string;
  verifier: string;
  rollbackScope: string;
  rationale: string | null;
  beforeHash: string | null;
  afterHash: string;
  createdAt: string;
  confirmed?: boolean;
  rolledBackAt?: string;
}

export interface AdminHarnessEvolutionManifestResponse {
  manifest: {
    schemaVersion: number;
    targetRoot: string;
    entries: AdminHarnessEvolutionManifestEntry[];
  };
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

export type AdminSecretAction =
  | 'secret.list_metadata'
  | 'secret.overwrite'
  | 'secret.unset';

export interface AdminSecretFingerprint {
  length: number;
  sha256_prefix: string;
}

export interface AdminSecretEntry {
  name: string;
  state: 'set' | 'unset';
  created_at: string | null;
  last_rotated_at: string | null;
  length: number | null;
  fingerprint: AdminSecretFingerprint | null;
}

export interface AdminSecretsResponse {
  secrets: AdminSecretEntry[];
  total: number;
  actions: AdminSecretAction[];
}

export interface AdminSecretMutationResponse {
  secret: AdminSecretEntry;
}

export interface DeleteSessionResult {
  deleted: boolean;
  sessionId: string;
  skippedReason?: 'has_user_messages';
  deletedMessages: number;
  deletedTasks: number;
  deletedSemanticMemories: number;
  deletedUsageEvents: number;
  deletedAuditEntries: number;
  deletedStructuredAuditEntries: number;
  deletedApprovalEntries: number;
}
