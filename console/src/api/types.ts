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
  telegram?: {
    tokenConfigured: boolean;
    tokenSource: 'config' | 'env' | 'runtime-secrets' | null;
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
  slack: {
    enabled: boolean;
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    defaultRequireMention: boolean;
    defaultReplyStyle: 'thread' | 'top-level';
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
  channelInstructions: {
    discord: string;
    msteams: string;
    slack: string;
    signal: string;
    telegram: string;
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

export interface AdminModelCatalogEntry {
  id: string;
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
  providerStatus: GatewayStatus['providerHealth'];
  models: AdminModelCatalogEntry[];
}

export type AdminSchedulerBoardStatus =
  | 'backlog'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled';

export interface AdminSchedulerJob {
  id: string;
  source: 'config' | 'task';
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
  path: string;
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

export interface AdminAgent {
  id: string;
  name: string | null;
  model: string | null;
  skills: string[] | null;
  chatbotId: string | null;
  enableRag: boolean | null;
  workspace: string | null;
  workspacePath: string;
  markdownFiles: AdminAgentMarkdownFile[];
}

export interface AdminAgentsResponse {
  agents: AdminAgent[];
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
  status: 'active' | 'idle' | 'stopped' | 'unused';
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

export type AgentsOverview = Pick<
  AgentsOverviewResponse,
  'agents' | 'sessions'
>;

export interface AgentListItem {
  id: string;
  name: string | null;
}

export interface AgentListResponse {
  agents: AgentListItem[];
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
  sessions: JobSession[];
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

export interface AdminPolicyState {
  exists: boolean;
  policyPath: string;
  workspacePath: string;
  defaultAction: 'allow' | 'deny';
  presets: string[];
  rules: AdminPolicyRule[];
}

export interface AdminPolicyPresetSummary {
  name: string;
  description: string;
}

export interface AdminApprovalsResponse {
  selectedAgentId: string;
  agents: AdminApprovalAgent[];
  pending: AdminPendingApproval[];
  policy: AdminPolicyState;
  availablePresets: AdminPolicyPresetSummary[];
}

export interface AdminSkill {
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

export interface AdminSkillsResponse {
  extraDirs: string[];
  disabled: string[];
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
  score: number;
  last_observed_at: string | null;
}

export interface AdminAgentScoreboardEntry {
  agent_id: string;
  display_name: string;
  total_executions: number;
  success_rate: number;
  avg_score: number;
  best_skills: AdminAgentSkillScore[];
  last_observed_at: string | null;
}

export interface AdminAgentScoreboardResponse {
  observed_skill_count: number;
  agents: AdminAgentScoreboardEntry[];
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
