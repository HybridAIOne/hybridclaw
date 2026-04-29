import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_GUARD_DEFAULTS,
  normalizeContextGuardConfig,
} from '../../container/shared/context-guard-config.js';
import {
  type AgentConfig,
  type AgentDefaultsConfig,
  type AgentModelConfig,
  type AgentsConfig,
  buildOptionalAgentPresentation,
  cloneAgentCv,
  DEFAULT_AGENT_ID,
  hasSnakeCamelAlias,
  normalizeAgentCv,
  normalizeAgentEscalationTarget,
  resolveSnakeCamelAlias,
  validateAgentOrgChart,
} from '../agents/agent-types.js';
import type {
  ChannelKind,
  SkillConfigChannelKind,
} from '../channels/channel.js';
import {
  normalizeChannelKind,
  normalizeSkillConfigChannelKind,
} from '../channels/channel-registry.js';
import type {
  MemoryEmbeddingDtype,
  MemoryEmbeddingProviderKind,
} from '../memory/embeddings.js';
import {
  DEFAULT_MEMORY_EMBEDDING_PROVIDER,
  DEFAULT_MEMORY_TRANSFORMERS_DTYPE,
  DEFAULT_MEMORY_TRANSFORMERS_MODEL,
  DEFAULT_MEMORY_TRANSFORMERS_REVISION,
  normalizeMemoryEmbeddingDtype,
  normalizeMemoryEmbeddingProviderKind,
} from '../memory/embeddings.js';
import type {
  MemoryQueryMode,
  MemoryRecallBackend,
  MemoryRecallRerank,
  MemoryRecallTokenizer,
} from '../memory/semantic-recall.js';
import {
  normalizeMemoryRecallBackend,
  normalizeMemoryRecallTokenizer,
} from '../memory/semantic-recall.js';
import { CODEX_DEFAULT_BASE_URL } from '../providers/codex-constants.js';
import type { LocalProviderConfig } from '../providers/local-types.js';
import {
  isRuntimeProviderId,
  type RuntimeProviderId,
} from '../providers/provider-ids.js';
import { DEFAULT_RESOURCE_HYGIENE_SCHEDULER_JOB } from '../scheduler/system-jobs.js';
import {
  isSecretRefInput,
  parseSecretInput,
  resolveSecretInput,
  type SecretInput,
} from '../security/secret-refs.js';
import {
  normalizeSessionResetMode,
  type SessionResetMode,
} from '../session/session-reset.js';
import {
  normalizeSessionDmScope,
  normalizeSessionIdentityLinks,
  type SessionDmScope,
} from '../session/session-routing.js';
import type { AdaptiveSkillsConfig } from '../skills/adaptive-skills-types.js';
import { DEFAULT_TUNNEL_HEALTH_CHECK_INTERVAL_MS } from '../tunnel/tunnel-provider.js';
import type { AnthropicMethod, McpServerConfig } from '../types/models.js';
import {
  normalizeOptionalTrimmedUniqueStringArray,
  normalizeTrimmedStringSet,
} from '../utils/normalized-strings.js';
import { expandHomePath } from '../utils/path.js';
import {
  clearRuntimeAssetRevisions as clearTrackedRuntimeAssetRevisions,
  clearRuntimeConfigRevisions as clearTrackedRuntimeConfigRevisions,
  deleteRuntimeAssetRevision as deleteTrackedRuntimeAssetRevision,
  deleteRuntimeConfigRevision as deleteTrackedRuntimeConfigRevision,
  getRuntimeAssetRevision as getTrackedRuntimeAssetRevision,
  getRuntimeAssetRevisionState as getTrackedRuntimeAssetRevisionState,
  getRuntimeAssetRevisionStateMetadata as getTrackedRuntimeAssetRevisionStateMetadata,
  getRuntimeConfigRevision as getTrackedRuntimeConfigRevision,
  getRuntimeConfigRevisionState as getTrackedRuntimeConfigRevisionState,
  getRuntimeConfigRevisionStateMetadata as getTrackedRuntimeConfigRevisionStateMetadata,
  listRuntimeAssetRevisions as listTrackedRuntimeAssetRevisions,
  listRuntimeConfigRevisions as listTrackedRuntimeConfigRevisions,
  type RuntimeConfigChangeMeta,
  type RuntimeConfigObservedFile,
  type RuntimeConfigRevision,
  type RuntimeConfigRevisionState,
  type RuntimeConfigRevisionStateMetadata,
  type RuntimeConfigRevisionSummary,
  type RuntimeRevisionAssetType,
  restoreRuntimeAssetRevision as restoreTrackedRuntimeAssetRevision,
  runtimeConfigRevisionStorePath,
  syncRuntimeConfigRevisionState,
  syncRuntimeAssetRevisionState as syncTrackedRuntimeAssetRevisionState,
} from './runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from './runtime-paths.js';

export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_VERSION = 25;
export const SECURITY_POLICY_VERSION = '2026-02-28';
export const DEFAULT_HYBRIDAI_MODEL = 'gpt-5.4-mini';
const LEGACY_DEFAULT_DB_PATH = 'data/hybridclaw.db';
const DEFAULT_VOICE_CHANNEL_INSTRUCTIONS = [
  'This is a live phone call. Produce plain spoken text only.',
  'Keep each reply short and conversational, usually one or two short sentences.',
  'Absolutely no markdown, bullets, numbered lists, headings, code fences, tables, JSON, or decorative formatting.',
  'Do not narrate internal reasoning, planning, tool usage, or stage directions. Say only what the caller should hear.',
  'Do not spell punctuation, formatting marks, or raw URLs unless the caller explicitly asks for exact characters.',
].join('\n');
const DEFAULT_CHANNEL_INSTRUCTIONS: RuntimeChannelInstructionsConfig = {
  discord: '',
  msteams: '',
  signal: '',
  slack: '',
  telegram: '',
  voice: DEFAULT_VOICE_CHANNEL_INSTRUCTIONS,
  whatsapp: '',
  email: '',
  imessage: '',
};
const DEFAULT_DB_PATH = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'data',
  'hybridclaw.db',
);

const KNOWN_LOG_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

type LogLevel =
  | 'fatal'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'trace'
  | 'silent';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface RuntimeSecurityConfig {
  trustModelAccepted: boolean;
  trustModelAcceptedAt: string;
  trustModelVersion: string;
  trustModelAcceptedBy: string;
}

export interface RuntimeConfigLoadError {
  trigger: string;
  path: string;
  message: string;
}

export type DiscordGroupPolicy = 'open' | 'allowlist' | 'disabled';
export type DiscordSendPolicy = 'open' | 'allowlist' | 'disabled';
export type DiscordCommandMode = 'public' | 'restricted';
export type DiscordChannelMode = 'off' | 'mention' | 'free';
export type DiscordTypingMode = 'instant' | 'thinking' | 'streaming' | 'never';
export type DiscordHumanDelayMode = 'off' | 'natural' | 'custom';
export type MSTeamsGroupPolicy = 'open' | 'allowlist' | 'disabled';
export type MSTeamsDmPolicy = 'open' | 'allowlist' | 'disabled';
export type MSTeamsReplyStyle = 'thread' | 'top-level';
export type DiscordAckReactionScope =
  | 'all'
  | 'group-mentions'
  | 'direct'
  | 'off';
export type DiscordPresenceActivityType =
  | 'playing'
  | 'watching'
  | 'listening'
  | 'competing'
  | 'custom';
export type SchedulerScheduleKind = 'at' | 'every' | 'cron' | 'one_shot';
export type SchedulerActionKind = 'agent_turn' | 'system_event';
export type SchedulerDeliveryKind = 'channel' | 'last-channel' | 'webhook';
export const DEFAULT_ONE_SHOT_MAX_RETRIES = 3;
export const SKILL_AUTONOMY_LEVELS = [
  'full-autonomous',
  'low-stakes-autonomous',
  'confirm-each',
] as const;
export type SkillAutonomyLevel = (typeof SKILL_AUTONOMY_LEVELS)[number];
export const SCHEDULER_BOARD_STATUSES = [
  'backlog',
  'in_progress',
  'review',
  'done',
  'cancelled',
] as const;
export type SchedulerBoardStatus = (typeof SCHEDULER_BOARD_STATUSES)[number];
const SCHEDULER_BOARD_STATUS_SET = new Set<string>(SCHEDULER_BOARD_STATUSES);
export type ContainerSandboxMode = 'container' | 'host';
export type RuntimeWebSearchProvider =
  | 'auto'
  | 'brave'
  | 'perplexity'
  | 'tavily'
  | 'duckduckgo'
  | 'searxng';
export type RuntimeWebSearchConcreteProvider = Exclude<
  RuntimeWebSearchProvider,
  'auto'
>;
export type WhatsAppDmPolicy = 'open' | 'pairing' | 'allowlist' | 'disabled';
export type WhatsAppGroupPolicy = 'open' | 'allowlist' | 'disabled';
export type SlackDmPolicy = 'open' | 'allowlist' | 'disabled';
export type SlackGroupPolicy = 'open' | 'allowlist' | 'disabled';
export type SlackReplyStyle = 'thread' | 'top-level';
export type TelegramDmPolicy = 'open' | 'allowlist' | 'disabled';
export type TelegramGroupPolicy = 'open' | 'allowlist' | 'disabled';
export type SignalDmPolicy = 'open' | 'allowlist' | 'disabled';
export type SignalGroupPolicy = 'open' | 'allowlist' | 'disabled';
export type IMessageBackend = 'local' | 'bluebubbles';
export type IMessageDmPolicy = 'open' | 'allowlist' | 'disabled';
export type IMessageGroupPolicy = 'open' | 'allowlist' | 'disabled';
export type RuntimeAudioTranscriptionProvider =
  | 'openai'
  | 'groq'
  | 'deepgram'
  | 'google';
export type RuntimeDeploymentMode = 'cloud' | 'local';
export const RUNTIME_DEPLOYMENT_TUNNEL_PROVIDERS = [
  'cloudflare',
  'manual',
  'ngrok',
  'ssh',
  'tailscale',
] as const;
export type RuntimeDeploymentKnownTunnelProvider =
  (typeof RUNTIME_DEPLOYMENT_TUNNEL_PROVIDERS)[number];
export type RuntimeDeploymentTunnelProvider =
  | RuntimeDeploymentKnownTunnelProvider
  | (string & {});

export interface RuntimeDeploymentTunnelConfig {
  provider?: RuntimeDeploymentTunnelProvider;
  health_check_interval_ms: number;
}

export interface RuntimeDeploymentConfig {
  mode: RuntimeDeploymentMode;
  public_url: string;
  tunnel: RuntimeDeploymentTunnelConfig;
}

export interface RuntimeAudioProviderModelConfig {
  type: 'provider';
  provider: RuntimeAudioTranscriptionProvider;
  model?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  prompt?: string;
  language?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface RuntimeAudioCliModelConfig {
  type: 'cli';
  command: string;
  args: string[];
  prompt?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export type RuntimeAudioTranscriptionModelConfig =
  | RuntimeAudioProviderModelConfig
  | RuntimeAudioCliModelConfig;

export type RuntimeAuxiliaryProviderSelection = 'auto' | RuntimeProviderId;

export interface RuntimeAuxiliaryModelPolicyConfig {
  provider: RuntimeAuxiliaryProviderSelection;
  model: string;
  maxTokens: number;
}

export interface RuntimeMediaAudioConfig {
  enabled: boolean;
  maxBytes: number;
  maxFiles: number;
  maxCharsPerTranscript: number;
  maxTotalChars: number;
  timeoutMs: number;
  prompt: string;
  language: string;
  models: RuntimeAudioTranscriptionModelConfig[];
}

export interface RuntimeRoutingConciergeConfig {
  enabled: boolean;
  model: string;
  profiles: {
    asap: string;
    balanced: string;
    noHurry: string;
  };
}

export interface RuntimeDiscordHumanDelayConfig {
  mode: DiscordHumanDelayMode;
  minMs: number;
  maxMs: number;
}

export interface RuntimeDiscordPresenceConfig {
  enabled: boolean;
  intervalMs: number;
  healthyText: string;
  degradedText: string;
  exhaustedText: string;
  activityType: DiscordPresenceActivityType;
}

export interface RuntimeDiscordLifecycleReactionsConfig {
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
}

export interface RuntimeDiscordChannelConfig {
  mode: DiscordChannelMode;
  typingMode?: DiscordTypingMode;
  debounceMs?: number;
  ackReaction?: string;
  ackReactionScope?: DiscordAckReactionScope;
  removeAckAfterReply?: boolean;
  humanDelay?: RuntimeDiscordHumanDelayConfig;
  rateLimitPerUser?: number;
  suppressPatterns?: string[];
  maxConcurrentPerChannel?: number;
  allowSend?: boolean;
  sendAllowedUserIds?: string[];
  sendAllowedRoleIds?: string[];
}

export interface RuntimeDiscordGuildConfig {
  defaultMode: DiscordChannelMode;
  channels: Record<string, RuntimeDiscordChannelConfig>;
  sendAllowedUserIds?: string[];
  sendAllowedRoleIds?: string[];
}

export interface RuntimeMSTeamsWebhookConfig {
  port: number;
  path: string;
}

export interface RuntimeMSTeamsChannelConfig {
  requireMention?: boolean;
  tools?: string[];
  replyStyle?: MSTeamsReplyStyle;
  groupPolicy?: MSTeamsGroupPolicy;
  allowFrom?: string[];
}

export interface RuntimeMSTeamsTeamConfig {
  requireMention?: boolean;
  tools?: string[];
  replyStyle?: MSTeamsReplyStyle;
  groupPolicy?: MSTeamsGroupPolicy;
  allowFrom?: string[];
  channels: Record<string, RuntimeMSTeamsChannelConfig>;
}

export interface RuntimeMSTeamsConfig {
  enabled: boolean;
  appId: string;
  tenantId: string;
  webhook: RuntimeMSTeamsWebhookConfig;
  groupPolicy: MSTeamsGroupPolicy;
  dmPolicy: MSTeamsDmPolicy;
  allowFrom: string[];
  teams: Record<string, RuntimeMSTeamsTeamConfig>;
  requireMention: boolean;
  textChunkLimit: number;
  replyStyle: MSTeamsReplyStyle;
  mediaMaxMb: number;
  dangerouslyAllowNameMatching: boolean;
  mediaAllowHosts: string[];
  mediaAuthAllowHosts: string[];
}

export interface RuntimeWhatsAppConfig {
  dmPolicy: WhatsAppDmPolicy;
  groupPolicy: WhatsAppGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  textChunkLimit: number;
  debounceMs: number;
  sendReadReceipts: boolean;
  ackReaction: string;
  mediaMaxMb: number;
}

export type RuntimeVoiceProvider = 'twilio';
export type RuntimeVoiceRelayTtsProvider = 'amazon' | 'default' | 'google';
export type RuntimeVoiceRelayTranscriptionProvider =
  | 'deepgram'
  | 'default'
  | 'google';

export interface RuntimeVoiceTwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface RuntimeVoiceRelayConfig {
  ttsProvider: RuntimeVoiceRelayTtsProvider;
  voice: string;
  transcriptionProvider: RuntimeVoiceRelayTranscriptionProvider;
  language: string;
  interruptible: boolean;
  welcomeGreeting: string;
}

export interface RuntimeVoiceConfig {
  enabled: boolean;
  provider: RuntimeVoiceProvider;
  twilio: RuntimeVoiceTwilioConfig;
  relay: RuntimeVoiceRelayConfig;
  webhookPath: string;
  maxConcurrentCalls: number;
}

export interface RuntimeSlackConfig {
  enabled: boolean;
  groupPolicy: SlackGroupPolicy;
  dmPolicy: SlackDmPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  requireMention: boolean;
  textChunkLimit: number;
  replyStyle: SlackReplyStyle;
  mediaMaxMb: number;
}

export interface RuntimeTelegramConfig {
  enabled: boolean;
  botToken: string;
  pollIntervalMs: number;
  dmPolicy: TelegramDmPolicy;
  groupPolicy: TelegramGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  requireMention: boolean;
  textChunkLimit: number;
  mediaMaxMb: number;
}

export interface RuntimeSignalConfig {
  enabled: boolean;
  daemonUrl: string;
  account: string;
  dmPolicy: SignalDmPolicy;
  groupPolicy: SignalGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  textChunkLimit: number;
  reconnectIntervalMs: number;
  outboundDelayMs: number;
}

export interface RuntimeIMessageConfig {
  enabled: boolean;
  backend: IMessageBackend;
  cliPath: string;
  dbPath: string;
  pollIntervalMs: number;
  serverUrl: string;
  password: string;
  webhookPath: string;
  allowPrivateNetwork: boolean;
  dmPolicy: IMessageDmPolicy;
  groupPolicy: IMessageGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  textChunkLimit: number;
  debounceMs: number;
  mediaMaxMb: number;
}

export interface RuntimeEmailConfig {
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
}

export interface RuntimeChannelInstructionsConfig {
  discord: string;
  msteams: string;
  signal: string;
  slack: string;
  telegram: string;
  voice: string;
  whatsapp: string;
  email: string;
  imessage: string;
}

export interface RuntimeSchedulerJob {
  id: string;
  name?: string;
  description?: string;
  agentId?: string;
  boardStatus?: SchedulerBoardStatus;
  maxRetries?: number | null;
  schedule: {
    kind: SchedulerScheduleKind;
    at: string | null;
    everyMs: number | null;
    expr: string | null;
    tz: string;
  };
  action: {
    kind: SchedulerActionKind;
    message: string;
  };
  delivery: {
    kind: SchedulerDeliveryKind;
    channel: string;
    to: string;
    webhookUrl: string;
  };
  enabled: boolean;
}

export interface RuntimePluginConfigEntry {
  id: string;
  enabled: boolean;
  path?: string;
  config: Record<string, unknown>;
}

export interface RuntimePluginsConfig {
  list: RuntimePluginConfigEntry[];
}

export interface RuntimeHttpRequestAuthRule {
  urlPrefix: string;
  header: string;
  prefix: string;
  secret: SecretInput;
}

export interface RuntimeHttpRequestToolConfig {
  authRules: RuntimeHttpRequestAuthRule[];
}

export interface RuntimeSkillAutonomyRule {
  agentId: string;
  skillName: string;
  level: SkillAutonomyLevel;
}

export interface RuntimeSkillAutonomyConfig {
  defaultLevel: SkillAutonomyLevel;
  rules: RuntimeSkillAutonomyRule[];
}

export interface RuntimeSkillCredentialManifest {
  id: string;
  env?: string;
  description?: string;
  required: boolean;
}

export type RuntimeSkillLifecycleStatus =
  | 'enabled'
  | 'disabled'
  | 'uninstalled';

export interface RuntimeInstalledSkillManifest {
  id: string;
  name: string;
  version: string;
  source: string;
  skillDir: string;
  manifestPath: string;
  status: RuntimeSkillLifecycleStatus;
  capabilities: string[];
  requiredCredentials: RuntimeSkillCredentialManifest[];
  supportedChannels: ChannelKind[];
  installedAt: string;
  updatedAt: string;
}

type RuntimeSkillAutonomyRuleIndex = Map<
  string,
  Map<string, SkillAutonomyLevel>
>;

const skillAutonomyRuleIndexes = new WeakMap<
  RuntimeSkillAutonomyConfig,
  RuntimeSkillAutonomyRuleIndex
>();

export interface RuntimeConfig {
  version: number;
  security: RuntimeSecurityConfig;
  deployment: RuntimeDeploymentConfig;
  agents: AgentsConfig;
  skills: {
    extraDirs: string[];
    disabled: string[];
    channelDisabled?: Partial<Record<SkillConfigChannelKind, string[]>>;
    autonomy: RuntimeSkillAutonomyConfig;
    installed: RuntimeInstalledSkillManifest[];
  };
  tools: {
    disabled: string[];
    httpRequest: RuntimeHttpRequestToolConfig;
  };
  channelInstructions: RuntimeChannelInstructionsConfig;
  plugins: RuntimePluginsConfig;
  adaptiveSkills: AdaptiveSkillsConfig;
  discord: {
    prefix: string;
    guildMembersIntent: boolean;
    presenceIntent: boolean;
    commandsOnly: boolean;
    commandMode: DiscordCommandMode;
    commandAllowedUserIds: string[];
    commandUserId: string;
    groupPolicy: DiscordGroupPolicy;
    sendPolicy: DiscordSendPolicy;
    sendAllowedChannelIds: string[];
    freeResponseChannels: string[];
    textChunkLimit: number;
    maxLinesPerMessage: number;
    humanDelay: RuntimeDiscordHumanDelayConfig;
    typingMode: DiscordTypingMode;
    presence: RuntimeDiscordPresenceConfig;
    lifecycleReactions: RuntimeDiscordLifecycleReactionsConfig;
    ackReaction: string;
    ackReactionScope: DiscordAckReactionScope;
    removeAckAfterReply: boolean;
    debounceMs: number;
    rateLimitPerUser: number;
    rateLimitExemptRoles: string[];
    suppressPatterns: string[];
    maxConcurrentPerChannel: number;
    guilds: Record<string, RuntimeDiscordGuildConfig>;
  };
  msteams: RuntimeMSTeamsConfig;
  signal: RuntimeSignalConfig;
  slack: RuntimeSlackConfig;
  telegram: RuntimeTelegramConfig;
  whatsapp: RuntimeWhatsAppConfig;
  voice: RuntimeVoiceConfig;
  imessage: RuntimeIMessageConfig;
  email: RuntimeEmailConfig;
  hybridai: {
    baseUrl: string;
    defaultModel: string;
    defaultChatbotId: string;
    maxTokens: number;
    enableRag: boolean;
    models: string[];
  };
  codex: {
    baseUrl: string;
    models: string[];
  };
  anthropic: {
    enabled: boolean;
    baseUrl: string;
    method: AnthropicMethod;
    models: string[];
  };
  openrouter: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  mistral: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  huggingface: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  gemini: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  deepseek: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  xai: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  zai: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  kimi: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  minimax: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  dashscope: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  xiaomi: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  kilo: {
    enabled: boolean;
    baseUrl: string;
    models: string[];
  };
  local: LocalProviderConfig;
  auxiliaryModels: {
    vision: RuntimeAuxiliaryModelPolicyConfig;
    compression: RuntimeAuxiliaryModelPolicyConfig;
    web_extract: RuntimeAuxiliaryModelPolicyConfig;
    session_search: RuntimeAuxiliaryModelPolicyConfig;
    skills_hub: RuntimeAuxiliaryModelPolicyConfig;
    eval_judge: RuntimeAuxiliaryModelPolicyConfig;
    mcp: RuntimeAuxiliaryModelPolicyConfig;
    flush_memories: RuntimeAuxiliaryModelPolicyConfig;
  };
  container: {
    sandboxMode: ContainerSandboxMode;
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
  mcpServers: Record<string, McpServerConfig>;
  web: {
    search: {
      provider: RuntimeWebSearchProvider;
      fallbackProviders: RuntimeWebSearchConcreteProvider[];
      defaultCount: number;
      cacheTtlMinutes: number;
      searxngBaseUrl: string;
      tavilySearchDepth: 'basic' | 'advanced';
    };
  };
  media: {
    audio: RuntimeMediaAudioConfig;
  };
  routing: {
    concierge: RuntimeRoutingConciergeConfig;
  };
  heartbeat: {
    enabled: boolean;
    intervalMs: number;
    channel: string;
  };
  memory: {
    decayRate: number;
    consolidationIntervalHours: number;
    consolidationLanguage: string;
    semanticPromptHardCap: number;
    embedding: {
      provider: MemoryEmbeddingProviderKind;
      model: string;
      revision: string;
      dtype: MemoryEmbeddingDtype;
    };
    queryMode: MemoryQueryMode;
    backend: MemoryRecallBackend;
    rerank: MemoryRecallRerank;
    tokenizer: MemoryRecallTokenizer;
  };
  ops: {
    healthHost: string;
    healthPort: number;
    webApiToken: string;
    gatewayBaseUrl: string;
    gatewayApiToken: string;
    dbPath: string;
    logLevel: LogLevel;
  };
  observability: {
    enabled: boolean;
    baseUrl: string;
    ingestPath: string;
    statusPath: string;
    botId: string;
    agentId: string;
    label: string;
    environment: string;
    flushIntervalMs: number;
    batchMaxEvents: number;
  };
  sessionCompaction: {
    enabled: boolean;
    tokenBudget: number;
    budgetRatio: number;
    threshold: number;
    keepRecent: number;
    summaryMaxChars: number;
    preCompactionMemoryFlush: {
      enabled: boolean;
      maxMessages: number;
      maxChars: number;
    };
    inLoopGuard: {
      enabled: boolean;
      perResultShare: number;
      compactionRatio: number;
      overflowRatio: number;
      maxRetries: number;
    };
  };
  sessionReset: {
    defaultPolicy: {
      mode: SessionResetMode;
      // Interpreted in the gateway host's local timezone, not UTC.
      atHour: number;
      idleMinutes: number;
    };
    byChannelKind?: Record<
      string,
      {
        mode?: SessionResetMode;
        // Interpreted in the gateway host's local timezone, not UTC.
        atHour?: number;
        idleMinutes?: number;
      }
    >;
  };
  sessionRouting: {
    dmScope: SessionDmScope;
    identityLinks: Record<string, string[]>;
  };
  promptHooks: {
    bootstrapEnabled: boolean;
    memoryEnabled: boolean;
    safetyEnabled: boolean;
    proactivityEnabled: boolean;
  };
  proactive: {
    activeHours: {
      enabled: boolean;
      timezone: string;
      startHour: number;
      endHour: number;
      queueOutsideHours: boolean;
    };
    delegation: {
      enabled: boolean;
      model: string;
      maxConcurrent: number;
      maxDepth: number;
      maxPerTurn: number;
    };
    autoRetry: {
      enabled: boolean;
      maxAttempts: number;
      baseDelayMs: number;
      maxDelayMs: number;
    };
    ralph: {
      maxIterations: number;
    };
  };
  scheduler: {
    jobs: RuntimeSchedulerJob[];
  };
}

export interface RuntimeSkillScopeConfigDraft {
  skills: {
    disabled: string[];
    channelDisabled?: Partial<Record<SkillConfigChannelKind, string[]>>;
  };
}

export interface RuntimeSkillScopeConfigView {
  skills?: {
    disabled?: string[];
    channelDisabled?: Partial<Record<SkillConfigChannelKind, string[]>>;
  };
}

export interface RuntimeToolScopeConfigDraft {
  tools: {
    disabled: string[];
    httpRequest?: {
      authRules?: RuntimeHttpRequestAuthRule[];
    };
  };
}

export interface RuntimeToolScopeConfigView {
  tools?: {
    disabled?: string[];
    httpRequest?: {
      authRules?: RuntimeHttpRequestAuthRule[];
    };
  };
}

export type RuntimeConfigChangeListener = (
  next: RuntimeConfig,
  prev: RuntimeConfig,
) => void;

const LEGACY_SINGLE_CODEX_MODEL_LIST = ['openai-codex/gpt-5-codex'];
const DEFAULT_CODEX_MODEL_LIST = [
  'openai-codex/gpt-5-codex',
  'openai-codex/gpt-5.3-codex',
  'openai-codex/gpt-5.4',
  'openai-codex/gpt-5.3-codex-spark',
  'openai-codex/gpt-5.2-codex',
  'openai-codex/gpt-5.1-codex-max',
  'openai-codex/gpt-5.2',
  'openai-codex/gpt-5.1-codex-mini',
] as const;
const DEFAULT_ANTHROPIC_MODEL_LIST = ['anthropic/claude-sonnet-4-6'] as const;
const DEFAULT_ANTHROPIC_METHOD: AnthropicMethod = 'api-key';
const DEFAULT_OPENROUTER_MODEL_LIST = [
  'openrouter/anthropic/claude-sonnet-4',
] as const;
const DEFAULT_MISTRAL_MODEL_LIST = ['mistral/mistral-large-latest'] as const;
const DEFAULT_HUGGINGFACE_MODEL_LIST = [
  'huggingface/meta-llama/Llama-3.1-8B-Instruct',
] as const;
const DEFAULT_GEMINI_MODEL_LIST = [
  'gemini/gemini-2.5-pro',
  'gemini/gemini-2.5-flash',
] as const;
const DEFAULT_DEEPSEEK_MODEL_LIST = [
  'deepseek/deepseek-chat',
  'deepseek/deepseek-reasoner',
] as const;
const DEFAULT_XAI_MODEL_LIST = ['xai/grok-3'] as const;
const DEFAULT_ZAI_MODEL_LIST = ['zai/glm-5.1'] as const;
const DEFAULT_KIMI_MODEL_LIST = ['kimi/kimi-k2.5'] as const;
const DEFAULT_MINIMAX_MODEL_LIST = ['minimax/MiniMax-M2'] as const;
const DEFAULT_DASHSCOPE_MODEL_LIST = ['dashscope/qwen3-coder-plus'] as const;
const DEFAULT_XIAOMI_MODEL_LIST = ['xiaomi/MiMo-7B-RL'] as const;
const DEFAULT_KILO_MODEL_LIST = ['kilo/anthropic/claude-sonnet-4.6'] as const;

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  version: CONFIG_VERSION,
  security: {
    trustModelAccepted: false,
    trustModelAcceptedAt: '',
    trustModelVersion: '',
    trustModelAcceptedBy: '',
  },
  deployment: {
    mode: 'local',
    public_url: '',
    tunnel: {
      provider: 'manual',
      health_check_interval_ms: DEFAULT_TUNNEL_HEALTH_CHECK_INTERVAL_MS,
    },
  },
  agents: {
    defaultAgentId: DEFAULT_AGENT_ID,
    defaults: {},
    list: [{ id: DEFAULT_AGENT_ID }],
  },
  skills: {
    extraDirs: [],
    disabled: [],
    channelDisabled: {},
    autonomy: {
      defaultLevel: 'confirm-each',
      rules: [],
    },
    installed: [],
  },
  tools: {
    disabled: [],
    httpRequest: {
      authRules: [],
    },
  },
  channelInstructions: {
    ...DEFAULT_CHANNEL_INSTRUCTIONS,
  },
  plugins: {
    list: [],
  },
  adaptiveSkills: {
    enabled: false,
    observationEnabled: true,
    trajectoryCapture: {
      enabledAgentIds: [],
      storeDir: '',
      retentionDays: 365,
      retentionDaysByTenant: {},
    },
    inspectionIntervalMs: 3_600_000,
    observationRetentionDays: 30,
    trailingWindowHours: 168,
    minExecutionsForInspection: 5,
    degradationSuccessRateThreshold: 0.6,
    degradationToolBreakageThreshold: 0.3,
    autoApplyEnabled: false,
    evaluationRunsBeforeRollback: 10,
    rollbackImprovementThreshold: 0.05,
  },
  discord: {
    prefix: '!claw',
    guildMembersIntent: false,
    presenceIntent: false,
    commandsOnly: false,
    commandMode: 'public',
    commandAllowedUserIds: [],
    commandUserId: '',
    groupPolicy: 'open',
    sendPolicy: 'open',
    sendAllowedChannelIds: [],
    freeResponseChannels: [],
    textChunkLimit: 2_000,
    maxLinesPerMessage: 17,
    humanDelay: {
      mode: 'natural',
      minMs: 800,
      maxMs: 2_500,
    },
    typingMode: 'thinking',
    presence: {
      enabled: true,
      intervalMs: 30_000,
      healthyText: 'Watching the channels',
      degradedText: 'Thinking slowly...',
      exhaustedText: 'Taking a break',
      activityType: 'watching',
    },
    lifecycleReactions: {
      enabled: true,
      removeOnComplete: true,
      phases: {
        queued: '⏳',
        thinking: '🤔',
        toolUse: '⚙️',
        streaming: '✍️',
        done: '✅',
        error: '❌',
      },
    },
    ackReaction: '👀',
    ackReactionScope: 'group-mentions',
    removeAckAfterReply: true,
    debounceMs: 2_500,
    rateLimitPerUser: 0,
    rateLimitExemptRoles: [],
    suppressPatterns: ['/stop', '/pause', 'brb', 'afk'],
    maxConcurrentPerChannel: 2,
    guilds: {},
  },
  msteams: {
    enabled: false,
    appId: '',
    tenantId: '',
    webhook: {
      port: 3_978,
      path: '/api/msteams/messages',
    },
    groupPolicy: 'allowlist',
    dmPolicy: 'allowlist',
    allowFrom: [],
    teams: {},
    requireMention: true,
    textChunkLimit: 4_000,
    replyStyle: 'thread',
    mediaMaxMb: 20,
    dangerouslyAllowNameMatching: false,
    mediaAllowHosts: [
      'graph.microsoft.com',
      '*.sharepoint.com',
      '*.sharepoint-df.com',
      '*.1drv.com',
      '*.onedrive.com',
      '*.teams.microsoft.com',
      '*.trafficmanager.net',
      '*.blob.core.windows.net',
      '*.azureedge.net',
      'teams.microsoft.com',
      'teams.cdn.office.net',
      'statics.teams.cdn.office.net',
      'asm.skype.com',
      'ams.skype.com',
      'media.ams.skype.com',
      'office.com',
      'office.net',
      '*.microsoft.com',
    ],
    mediaAuthAllowHosts: [
      'graph.microsoft.com',
      '*.teams.microsoft.com',
      'api.botframework.com',
      'botframework.com',
      'teams.microsoft.com',
    ],
  },
  slack: {
    enabled: false,
    groupPolicy: 'allowlist',
    dmPolicy: 'allowlist',
    allowFrom: [],
    groupAllowFrom: [],
    requireMention: true,
    textChunkLimit: 12_000,
    replyStyle: 'thread',
    mediaMaxMb: 20,
  },
  telegram: {
    enabled: false,
    botToken: '',
    pollIntervalMs: 1_500,
    dmPolicy: 'allowlist',
    groupPolicy: 'disabled',
    allowFrom: [],
    groupAllowFrom: [],
    requireMention: true,
    textChunkLimit: 4_000,
    mediaMaxMb: 20,
  },
  signal: {
    enabled: false,
    daemonUrl: '',
    account: '',
    dmPolicy: 'allowlist',
    groupPolicy: 'disabled',
    allowFrom: [],
    groupAllowFrom: [],
    textChunkLimit: 4_000,
    reconnectIntervalMs: 5_000,
    outboundDelayMs: 350,
  },
  whatsapp: {
    dmPolicy: 'pairing',
    groupPolicy: 'disabled',
    allowFrom: [],
    groupAllowFrom: [],
    textChunkLimit: 4_000,
    debounceMs: 2_500,
    sendReadReceipts: true,
    ackReaction: '👀',
    mediaMaxMb: 20,
  },
  voice: {
    enabled: false,
    provider: 'twilio',
    twilio: {
      accountSid: '',
      authToken: '',
      fromNumber: '',
    },
    relay: {
      ttsProvider: 'default',
      voice: '',
      transcriptionProvider: 'default',
      language: 'en-US',
      interruptible: true,
      welcomeGreeting: 'Hello! How can I help you today?',
    },
    webhookPath: '/voice',
    maxConcurrentCalls: 8,
  },
  imessage: {
    enabled: false,
    backend: 'local',
    cliPath: 'imsg',
    dbPath: path.join(os.homedir(), 'Library', 'Messages', 'chat.db'),
    pollIntervalMs: 2_500,
    serverUrl: '',
    password: '',
    webhookPath: '/api/imessage/webhook',
    allowPrivateNetwork: false,
    dmPolicy: 'allowlist',
    groupPolicy: 'disabled',
    allowFrom: [],
    groupAllowFrom: [],
    textChunkLimit: 4_000,
    debounceMs: 2_500,
    mediaMaxMb: 20,
  },
  email: {
    enabled: false,
    imapHost: '',
    imapPort: 993,
    imapSecure: true,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    address: '',
    password: '',
    pollIntervalMs: 30_000,
    folders: ['INBOX'],
    allowFrom: [],
    textChunkLimit: 50_000,
    mediaMaxMb: 20,
  },
  hybridai: {
    baseUrl: 'https://hybridai.one',
    defaultModel: DEFAULT_HYBRIDAI_MODEL,
    defaultChatbotId: '',
    maxTokens: 4_096,
    enableRag: true,
    models: ['gpt-4.1-mini', 'gpt-5-nano', 'gpt-5-mini', 'gpt-5'],
  },
  codex: {
    baseUrl: CODEX_DEFAULT_BASE_URL,
    models: [...DEFAULT_CODEX_MODEL_LIST],
  },
  anthropic: {
    enabled: false,
    baseUrl: 'https://api.anthropic.com/v1',
    method: DEFAULT_ANTHROPIC_METHOD,
    models: [...DEFAULT_ANTHROPIC_MODEL_LIST],
  },
  openrouter: {
    enabled: false,
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [...DEFAULT_OPENROUTER_MODEL_LIST],
  },
  mistral: {
    enabled: false,
    baseUrl: 'https://api.mistral.ai/v1',
    models: [...DEFAULT_MISTRAL_MODEL_LIST],
  },
  huggingface: {
    enabled: false,
    baseUrl: 'https://router.huggingface.co/v1',
    models: [...DEFAULT_HUGGINGFACE_MODEL_LIST],
  },
  gemini: {
    enabled: false,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [...DEFAULT_GEMINI_MODEL_LIST],
  },
  deepseek: {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/v1',
    models: [...DEFAULT_DEEPSEEK_MODEL_LIST],
  },
  xai: {
    enabled: false,
    baseUrl: 'https://api.x.ai/v1',
    models: [...DEFAULT_XAI_MODEL_LIST],
  },
  zai: {
    enabled: false,
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: [...DEFAULT_ZAI_MODEL_LIST],
  },
  kimi: {
    enabled: false,
    baseUrl: 'https://api.moonshot.ai/v1',
    models: [...DEFAULT_KIMI_MODEL_LIST],
  },
  minimax: {
    enabled: false,
    baseUrl: 'https://api.minimax.io/v1',
    models: [...DEFAULT_MINIMAX_MODEL_LIST],
  },
  dashscope: {
    enabled: false,
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: [...DEFAULT_DASHSCOPE_MODEL_LIST],
  },
  xiaomi: {
    enabled: false,
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: [...DEFAULT_XIAOMI_MODEL_LIST],
  },
  kilo: {
    enabled: false,
    baseUrl: 'https://api.kilo.ai/api/gateway',
    models: [...DEFAULT_KILO_MODEL_LIST],
  },
  local: {
    backends: {
      ollama: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434',
      },
      lmstudio: {
        enabled: false,
        baseUrl: 'http://127.0.0.1:1234/v1',
      },
      llamacpp: {
        enabled: false,
        baseUrl: 'http://127.0.0.1:8081/v1',
      },
      vllm: {
        enabled: false,
        baseUrl: 'http://127.0.0.1:8000/v1',
        apiKey: '',
      },
    },
    discovery: {
      enabled: true,
      intervalMs: 3_600_000,
      maxModels: 200,
      concurrency: 8,
    },
    healthCheck: {
      enabled: true,
      intervalMs: 60_000,
      timeoutMs: 5_000,
    },
    defaultContextWindow: 128_000,
    defaultMaxTokens: 8_192,
  },
  auxiliaryModels: {
    vision: {
      provider: 'auto',
      model: '',
      maxTokens: 0,
    },
    compression: {
      provider: 'auto',
      model: '',
      maxTokens: 0,
    },
    web_extract: {
      provider: 'auto',
      model: '',
      maxTokens: 0,
    },
    session_search: {
      provider: 'auto',
      model: '',
      maxTokens: 0,
    },
    skills_hub: {
      provider: 'auto',
      model: '',
      maxTokens: 0,
    },
    eval_judge: {
      provider: 'auto',
      model: '',
      maxTokens: 0,
    },
    mcp: {
      provider: 'auto',
      model: '',
      maxTokens: 0,
    },
    flush_memories: {
      provider: 'auto',
      model: '',
      maxTokens: 0,
    },
  },
  container: {
    sandboxMode: 'container',
    image: 'hybridclaw-agent',
    memory: '512m',
    memorySwap: '',
    cpus: '1',
    network: 'bridge',
    timeoutMs: 300_000,
    binds: [],
    additionalMounts: '',
    maxOutputBytes: 10_485_760,
    maxConcurrent: 5,
    persistBashState: true,
  },
  mcpServers: {},
  web: {
    search: {
      provider: 'auto',
      fallbackProviders: [],
      defaultCount: 5,
      cacheTtlMinutes: 5,
      searxngBaseUrl: '',
      tavilySearchDepth: 'advanced',
    },
  },
  media: {
    audio: {
      enabled: true,
      maxBytes: 20 * 1024 * 1024,
      maxFiles: 4,
      maxCharsPerTranscript: 8_000,
      maxTotalChars: 16_000,
      timeoutMs: 60_000,
      prompt: 'Transcribe the audio.',
      language: '',
      models: [],
    },
  },
  routing: {
    concierge: {
      enabled: false,
      model: 'gemini-3-flash',
      profiles: {
        asap: 'gpt-5',
        balanced: 'gpt-5-mini',
        noHurry: 'gpt-5-nano',
      },
    },
  },
  heartbeat: {
    enabled: true,
    intervalMs: 1_800_000,
    channel: '',
  },
  memory: {
    decayRate: 0.1,
    consolidationIntervalHours: 24,
    consolidationLanguage: 'en',
    semanticPromptHardCap: 12,
    embedding: {
      provider: DEFAULT_MEMORY_EMBEDDING_PROVIDER,
      model: DEFAULT_MEMORY_TRANSFORMERS_MODEL,
      revision: DEFAULT_MEMORY_TRANSFORMERS_REVISION,
      dtype: DEFAULT_MEMORY_TRANSFORMERS_DTYPE,
    },
    queryMode: 'no-stopwords',
    backend: 'hybrid',
    rerank: 'bm25',
    tokenizer: 'porter',
  },
  ops: {
    healthHost: '127.0.0.1',
    healthPort: 9090,
    webApiToken: '',
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    gatewayApiToken: '',
    dbPath: DEFAULT_DB_PATH,
    logLevel: 'info',
  },
  observability: {
    enabled: true,
    baseUrl: 'https://hybridai.one',
    ingestPath: '/api/v1/agent-observability/events:batch',
    statusPath: '/api/v1/agent-observability/status',
    botId: '',
    agentId: 'agent_main',
    label: '',
    environment: 'prod',
    flushIntervalMs: 10_000,
    batchMaxEvents: 500,
  },
  sessionCompaction: {
    enabled: true,
    tokenBudget: 100_000,
    budgetRatio: 0.7,
    threshold: 200,
    keepRecent: 40,
    summaryMaxChars: 8_000,
    preCompactionMemoryFlush: {
      enabled: true,
      maxMessages: 80,
      maxChars: 24_000,
    },
    inLoopGuard: { ...CONTEXT_GUARD_DEFAULTS },
  },
  sessionReset: {
    defaultPolicy: {
      mode: 'both',
      atHour: 4,
      idleMinutes: 1440,
    },
  },
  sessionRouting: {
    dmScope: 'per-channel-peer',
    identityLinks: {},
  },
  promptHooks: {
    bootstrapEnabled: true,
    memoryEnabled: true,
    safetyEnabled: true,
    proactivityEnabled: true,
  },
  proactive: {
    activeHours: {
      enabled: false,
      timezone: '',
      startHour: 8,
      endHour: 22,
      queueOutsideHours: true,
    },
    delegation: {
      enabled: true,
      model: '',
      maxConcurrent: 3,
      maxDepth: 2,
      maxPerTurn: 3,
    },
    autoRetry: {
      enabled: true,
      maxAttempts: 3,
      baseDelayMs: 2_000,
      maxDelayMs: 8_000,
    },
    ralph: {
      maxIterations: 0,
    },
  },
  scheduler: {
    jobs: [DEFAULT_RESOURCE_HYGIENE_SCHEDULER_JOB],
  },
};

const CONFIG_PATH = path.join(DEFAULT_RUNTIME_HOME_DIR, CONFIG_FILE_NAME);
const SECRET_INPUT_PATHS = [
  'ops.webApiToken',
  'ops.gatewayApiToken',
  'email.password',
  'imessage.password',
  'telegram.botToken',
  'voice.twilio.authToken',
  'local.backends.vllm.apiKey',
] as const;
type RuntimeConfigSecretInputPath = (typeof SECRET_INPUT_PATHS)[number];

let currentConfig: RuntimeConfig = cloneConfig(DEFAULT_RUNTIME_CONFIG);
let currentConfigSource: Record<string, unknown> = {};
let currentConfigMetadata = {
  containerSandboxModeExplicit: false,
  containerMaxConcurrentExplicit: false,
};
let currentConfigLoadError: RuntimeConfigLoadError | null = null;
let configWatcher: fs.FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<RuntimeConfigChangeListener>();
const WATCHER_RETRY_BASE_DELAY_MS = 1_000;
const WATCHER_RETRY_MAX_DELAY_MS = 60_000;
const WATCHER_RETRY_MAX_ATTEMPTS = 10;
const WATCHER_STABLE_RESET_DELAY_MS = 1_000;
const NON_RETRYABLE_WATCHER_ERROR_CODES = new Set([
  'EMFILE',
  'ENFILE',
  'ENOSPC',
]);
let watcherRetryAttempt = 0;
let watcherRestartTimer: ReturnType<typeof setTimeout> | null = null;
let watcherStableTimer: ReturnType<typeof setTimeout> | null = null;
let watcherPermanentlyDisabled = false;

function detachTimer(timer: ReturnType<typeof setTimeout>): void {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  ) {
    timer.unref();
  }
}

function startDetachedTimer(
  callback: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  detachTimer(timer);
  return timer;
}

function isRuntimeConfigWatcherDisabled(): boolean {
  const raw = String(process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER || '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function getWatcherErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

function disableWatcher(reason: string): void {
  watcherPermanentlyDisabled = true;
  if (watcherRestartTimer) {
    clearTimeout(watcherRestartTimer);
    watcherRestartTimer = null;
  }
  if (watcherStableTimer) {
    clearTimeout(watcherStableTimer);
    watcherStableTimer = null;
  }
  console.warn(`[runtime-config] watcher disabled: ${reason}`);
}

function shouldRetryWatcherError(err: unknown): boolean {
  const code = getWatcherErrorCode(err);
  return !NON_RETRYABLE_WATCHER_ERROR_CODES.has(code);
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(
  value: unknown,
  fallback: string,
  opts?: { allowEmpty?: boolean; trim?: boolean },
): string {
  const trim = opts?.trim !== false;
  const allowEmpty = opts?.allowEmpty ?? true;
  if (typeof value !== 'string') return fallback;
  const normalized = trim ? value.trim() : value;
  if (!allowEmpty && normalized.length === 0) return fallback;
  return normalized;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = Math.trunc(value);
  } else if (typeof value === 'string' && value.trim()) {
    parsed = Number.parseInt(value, 10);
  } else {
    parsed = fallback;
  }

  if (!Number.isFinite(parsed)) parsed = fallback;
  if (opts?.min != null && parsed < opts.min) parsed = opts.min;
  if (opts?.max != null && parsed > opts.max) parsed = opts.max;
  return parsed;
}

function normalizeNumber(
  value: unknown,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim()) {
    parsed = Number.parseFloat(value);
  } else {
    parsed = fallback;
  }

  if (!Number.isFinite(parsed)) parsed = fallback;
  if (opts?.min != null && parsed < opts.min) parsed = opts.min;
  if (opts?.max != null && parsed > opts.max) parsed = opts.max;
  return parsed;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    if (normalized.length > 0) return normalized;
    return fallback;
  }

  if (typeof value === 'string') {
    const parsed = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return parsed.length > 0 ? parsed : fallback;
  }

  return fallback;
}

function normalizeRetentionDaysByTenant(
  value: unknown,
  fallback: Record<string, number>,
  defaultRetentionDays: number,
): Record<string, number> {
  if (!isRecord(value)) return { ...fallback };
  const normalized: Record<string, number> = {};
  for (const [tenantId, rawDays] of Object.entries(value)) {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) continue;
    normalized[normalizedTenantId] = normalizeInteger(
      rawDays,
      fallback[normalizedTenantId] ?? defaultRetentionDays,
      { min: 0 },
    );
  }
  return normalized;
}

function normalizeOptionalBaseUrl(value: unknown, fallback: string): string {
  const candidate = normalizeString(value, fallback, { allowEmpty: true });
  return candidate ? candidate.replace(/\/+$/, '') : '';
}

function normalizeDeploymentMode(
  value: unknown,
  fallback: RuntimeDeploymentMode,
): RuntimeDeploymentMode {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cloud' || normalized === 'local') return normalized;
  return fallback;
}

function normalizeDeploymentTunnelProvider(
  value: unknown,
  fallback: RuntimeDeploymentTunnelProvider | undefined,
): RuntimeDeploymentTunnelProvider | undefined {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (
    (RUNTIME_DEPLOYMENT_TUNNEL_PROVIDERS as readonly string[]).includes(
      normalized,
    )
  ) {
    return normalized as RuntimeDeploymentKnownTunnelProvider;
  }
  if (normalized === 'cloudflared' || normalized === 'cloudflare-tunnel') {
    return 'cloudflare';
  }
  if (normalized === 'tailscale-funnel' || normalized === 'tailscale-serve') {
    return 'tailscale';
  }
  if (normalized === 'reverse-proxy' || normalized === 'proxy') {
    return 'manual';
  }
  return normalized;
}

export function normalizeDeploymentConfig(
  value: unknown,
  fallback: RuntimeDeploymentConfig,
): RuntimeDeploymentConfig {
  const raw = isRecord(value) ? value : {};
  const rawTunnel = isRecord(raw.tunnel) ? raw.tunnel : {};
  const tunnelProvider = normalizeDeploymentTunnelProvider(
    rawTunnel.provider,
    fallback.tunnel.provider,
  );
  return {
    mode: normalizeDeploymentMode(raw.mode, fallback.mode),
    public_url: normalizeOptionalBaseUrl(raw.public_url, fallback.public_url),
    tunnel: {
      ...(tunnelProvider ? { provider: tunnelProvider } : {}),
      health_check_interval_ms: normalizeInteger(
        rawTunnel.health_check_interval_ms,
        fallback.tunnel.health_check_interval_ms,
        { min: 1 },
      ),
    },
  };
}

function normalizeSkillAutonomyLevel(
  value: unknown,
  fallback: SkillAutonomyLevel,
): SkillAutonomyLevel {
  const normalized = normalizeString(value, fallback, {
    allowEmpty: false,
  }).toLowerCase();
  return SKILL_AUTONOMY_LEVELS.includes(normalized as SkillAutonomyLevel)
    ? (normalized as SkillAutonomyLevel)
    : fallback;
}

function normalizeSkillAutonomyConfig(
  value: unknown,
  fallback: RuntimeSkillAutonomyConfig,
): RuntimeSkillAutonomyConfig {
  const raw = isRecord(value) ? value : {};
  const defaultLevel = normalizeSkillAutonomyLevel(
    raw.defaultLevel,
    fallback.defaultLevel,
  );
  const rulesByKey = new Map<string, RuntimeSkillAutonomyRule>();
  const rawRules = Array.isArray(raw.rules) ? raw.rules : [];
  for (const item of rawRules) {
    if (!isRecord(item)) {
      console.warn(
        '[runtime-config] skipping skills.autonomy rule: expected an object',
      );
      continue;
    }
    const agentId = normalizeString(item.agentId, '', {
      allowEmpty: false,
    });
    const skillName = normalizeString(item.skillName, '', {
      allowEmpty: false,
    });
    if (!agentId || !skillName) {
      console.warn(
        '[runtime-config] skipping skills.autonomy rule with empty agentId or skillName',
      );
      continue;
    }
    const level = normalizeSkillAutonomyLevel(item.level, defaultLevel);
    if (
      typeof item.level === 'string' &&
      item.level.trim() &&
      level !== item.level.trim().toLowerCase()
    ) {
      console.warn(
        `[runtime-config] invalid skills.autonomy level "${item.level.trim()}" for agentId "${agentId}" and skillName "${skillName}"; using default "${defaultLevel}"`,
      );
    }
    rulesByKey.set(JSON.stringify([agentId, skillName]), {
      agentId,
      skillName,
      level,
    });
  }

  return {
    defaultLevel,
    rules: [...rulesByKey.values()].sort((a, b) => {
      const byAgent = a.agentId.localeCompare(b.agentId);
      return byAgent || a.skillName.localeCompare(b.skillName);
    }),
  };
}

function getSkillAutonomyRuleIndex(
  autonomy: RuntimeSkillAutonomyConfig,
): RuntimeSkillAutonomyRuleIndex {
  const cached = skillAutonomyRuleIndexes.get(autonomy);
  if (cached) return cached;

  const index: RuntimeSkillAutonomyRuleIndex = new Map();
  for (const rule of autonomy.rules) {
    let skillRules = index.get(rule.agentId);
    if (!skillRules) {
      skillRules = new Map<string, SkillAutonomyLevel>();
      index.set(rule.agentId, skillRules);
    }
    skillRules.set(rule.skillName, rule.level);
  }
  skillAutonomyRuleIndexes.set(autonomy, index);
  return index;
}

function normalizeSkillChannelDisabled(
  value: unknown,
): Partial<Record<SkillConfigChannelKind, string[]>> {
  const rawChannelDisabled = isRecord(value) ? value : {};
  const channelDisabled: Partial<Record<SkillConfigChannelKind, string[]>> = {};
  for (const [key, rawDisabled] of Object.entries(rawChannelDisabled)) {
    const channelKind = normalizeSkillConfigChannelKind(key);
    if (!channelKind) {
      console.warn(
        `[runtime-config] ignored unknown skills.channelDisabled key: ${key}`,
      );
      continue;
    }
    channelDisabled[channelKind] = normalizeStringArray(rawDisabled, []);
  }
  return channelDisabled;
}

function normalizeSkillLifecycleStatus(
  value: unknown,
): RuntimeSkillLifecycleStatus {
  const normalized = normalizeString(value, 'enabled', {
    allowEmpty: false,
  }).toLowerCase();
  return normalized === 'disabled' || normalized === 'uninstalled'
    ? normalized
    : 'enabled';
}

function normalizeRuntimeSkillCredentialManifests(
  value: unknown,
): RuntimeSkillCredentialManifest[] {
  if (!Array.isArray(value)) return [];

  const credentials: RuntimeSkillCredentialManifest[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = normalizeString(item.id, '', { allowEmpty: false });
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const env = normalizeString(item.env, '', { allowEmpty: true });
    const description = normalizeString(item.description, '', {
      allowEmpty: true,
    });
    credentials.push({
      id,
      ...(env ? { env } : {}),
      ...(description ? { description } : {}),
      required: item.required === undefined ? true : item.required !== false,
    });
  }
  return credentials;
}

function normalizeRuntimeSkillSupportedChannels(value: unknown): ChannelKind[] {
  const channels: ChannelKind[] = [];
  const seen = new Set<ChannelKind>();
  for (const raw of normalizeStringArray(value, [])) {
    const normalized =
      raw.toLowerCase() === 'web' ? 'tui' : normalizeChannelKind(raw);
    if (
      !normalized ||
      normalized === 'heartbeat' ||
      normalized === 'scheduler'
    ) {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    channels.push(normalized);
  }
  return channels;
}

function normalizeRuntimeInstalledSkillManifests(
  value: unknown,
): RuntimeInstalledSkillManifest[] {
  if (!Array.isArray(value)) return [];

  const manifestsById = new Map<string, RuntimeInstalledSkillManifest>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = normalizeString(item.id, '', { allowEmpty: false });
    const name = normalizeString(item.name, id, { allowEmpty: false });
    if (!id || !name) continue;
    const version = normalizeString(item.version, '0.0.0', {
      allowEmpty: false,
    });
    const source = normalizeString(item.source, 'unknown', {
      allowEmpty: false,
    });
    const skillDir = normalizeString(item.skillDir, '', {
      allowEmpty: false,
    });
    const manifestPath = normalizeString(item.manifestPath, '', {
      allowEmpty: false,
    });
    const installedAt = normalizeString(item.installedAt, '', {
      allowEmpty: true,
    });
    const updatedAt = normalizeString(item.updatedAt, '', {
      allowEmpty: true,
    });
    manifestsById.set(id, {
      id,
      name,
      version,
      source,
      skillDir,
      manifestPath,
      status: normalizeSkillLifecycleStatus(item.status),
      capabilities: normalizeStringArray(item.capabilities, []),
      requiredCredentials: normalizeRuntimeSkillCredentialManifests(
        item.requiredCredentials,
      ),
      supportedChannels: normalizeRuntimeSkillSupportedChannels(
        item.supportedChannels,
      ),
      installedAt,
      updatedAt,
    });
  }

  return [...manifestsById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export function setRuntimeSkillScopeEnabled(
  draft: RuntimeSkillScopeConfigDraft,
  skillName: string,
  enabled: boolean,
  channelKind?: SkillConfigChannelKind,
): void {
  const disabled = getRuntimeSkillScopeDisabledNames(draft, channelKind);
  if (enabled) {
    disabled.delete(skillName);
  } else {
    disabled.add(skillName);
  }
  const nextDisabled = [...disabled].sort((left, right) =>
    left.localeCompare(right),
  );
  if (channelKind) {
    draft.skills.channelDisabled = {
      ...(draft.skills.channelDisabled ?? {}),
      [channelKind]: nextDisabled,
    };
    return;
  }
  draft.skills.disabled = nextDisabled;
}

export function getRuntimeSkillScopeDisabledNames(
  config: RuntimeSkillScopeConfigView,
  channelKind?: SkillConfigChannelKind | string,
): Set<string> {
  const normalizedChannelKind = normalizeSkillConfigChannelKind(channelKind);
  const rawDisabled = normalizedChannelKind
    ? (config.skills?.channelDisabled?.[normalizedChannelKind] ?? [])
    : (config.skills?.disabled ?? []);
  return normalizeTrimmedStringSet(rawDisabled);
}

export function getRuntimeDisabledSkillNames(
  config: RuntimeSkillScopeConfigView,
  channelKind?: SkillConfigChannelKind | string,
): Set<string> {
  const disabled = getRuntimeSkillScopeDisabledNames(config);
  const normalizedChannelKind = normalizeSkillConfigChannelKind(channelKind);
  if (!normalizedChannelKind) return disabled;

  for (const name of getRuntimeSkillScopeDisabledNames(
    config,
    normalizedChannelKind,
  )) {
    disabled.add(name);
  }
  return disabled;
}

export function setRuntimeToolEnabled(
  draft: RuntimeToolScopeConfigDraft,
  toolName: string,
  enabled: boolean,
): void {
  const disabled = getRuntimeDisabledToolNames(draft);
  if (enabled) {
    disabled.delete(toolName);
  } else {
    disabled.add(toolName);
  }
  draft.tools.disabled = [...disabled].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function getRuntimeDisabledToolNames(
  config: RuntimeToolScopeConfigView,
): Set<string> {
  return normalizeTrimmedStringSet(config.tools?.disabled ?? []);
}

function cloneAgentModelConfig(
  value: AgentModelConfig | undefined,
): AgentModelConfig | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return {
    primary: value.primary,
    ...(Array.isArray(value.fallbacks) && value.fallbacks.length > 0
      ? { fallbacks: [...value.fallbacks] }
      : {}),
  };
}

function normalizeAgentModelConfig(
  value: unknown,
  fallback?: AgentModelConfig,
): AgentModelConfig | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || cloneAgentModelConfig(fallback);
  }
  if (!isRecord(value)) return cloneAgentModelConfig(fallback);

  const primary = normalizeString(value.primary, '', { allowEmpty: true });
  if (!primary) return cloneAgentModelConfig(fallback);
  const fallbacks = normalizeStringArray(value.fallbacks, []).filter(
    (candidate) => candidate !== primary,
  );
  return fallbacks.length > 0 ? { primary, fallbacks } : { primary };
}

function normalizeAgentDefaultsConfig(
  value: unknown,
  fallback: AgentDefaultsConfig,
): AgentDefaultsConfig {
  if (!isRecord(value)) return { ...fallback };
  const model = normalizeAgentModelConfig(value.model, fallback.model);
  const chatbotId = normalizeString(value.chatbotId, fallback.chatbotId ?? '', {
    allowEmpty: true,
  });
  const enableRag =
    typeof value.enableRag === 'boolean' ? value.enableRag : fallback.enableRag;
  return {
    ...(model ? { model } : {}),
    ...(chatbotId ? { chatbotId } : {}),
    ...(typeof enableRag === 'boolean' ? { enableRag } : {}),
  };
}

function normalizeAgentConfig(
  value: unknown,
  fallback?: AgentConfig,
): AgentConfig | null {
  if (!isRecord(value)) return fallback ? { ...fallback } : null;
  const id = normalizeString(value.id, fallback?.id ?? '', {
    allowEmpty: false,
  });
  if (!id) return null;
  const name = normalizeString(value.name, fallback?.name ?? '', {
    allowEmpty: true,
  });
  const displayName = normalizeString(
    value.displayName,
    fallback?.displayName ?? '',
    {
      allowEmpty: true,
    },
  );
  const imageAsset = normalizeString(
    value.imageAsset,
    fallback?.imageAsset ?? '',
    {
      allowEmpty: true,
    },
  );
  const model = normalizeAgentModelConfig(value.model, fallback?.model);
  const workspace = normalizeString(
    value.workspace,
    fallback?.workspace ?? '',
    {
      allowEmpty: true,
    },
  );
  const chatbotId = normalizeString(
    value.chatbotId,
    fallback?.chatbotId ?? '',
    {
      allowEmpty: true,
    },
  );
  const enableRag =
    typeof value.enableRag === 'boolean'
      ? value.enableRag
      : fallback?.enableRag;
  const skills = Object.hasOwn(value, 'skills')
    ? normalizeOptionalTrimmedUniqueStringArray(value.skills)
    : fallback?.skills
      ? [...fallback.skills]
      : undefined;
  const owner = normalizeString(value.owner, fallback?.owner ?? '', {
    allowEmpty: true,
  });
  const role = normalizeString(value.role, fallback?.role ?? '', {
    allowEmpty: true,
  });
  const reportsTo = normalizeString(
    resolveSnakeCamelAlias(value, 'reportsTo', 'reports_to'),
    fallback?.reportsTo ?? '',
    {
      allowEmpty: true,
    },
  );
  const delegatesTo = hasSnakeCamelAlias(value, 'delegatesTo', 'delegates_to')
    ? normalizeOptionalTrimmedUniqueStringArray(
        resolveSnakeCamelAlias(value, 'delegatesTo', 'delegates_to'),
      )
    : fallback?.delegatesTo
      ? [...fallback.delegatesTo]
      : undefined;
  const peers = Object.hasOwn(value, 'peers')
    ? normalizeOptionalTrimmedUniqueStringArray(value.peers)
    : fallback?.peers
      ? [...fallback.peers]
      : undefined;
  const cv = Object.hasOwn(value, 'cv')
    ? normalizeAgentCv(value.cv)
    : cloneAgentCv(fallback?.cv);
  const escalationTarget = Object.hasOwn(value, 'escalationTarget')
    ? normalizeAgentEscalationTarget(value.escalationTarget)
    : fallback?.escalationTarget
      ? { ...fallback.escalationTarget }
      : undefined;
  return {
    id,
    ...(name ? { name } : {}),
    ...buildOptionalAgentPresentation(displayName, imageAsset),
    ...(model ? { model } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(workspace ? { workspace } : {}),
    ...(chatbotId ? { chatbotId } : {}),
    ...(typeof enableRag === 'boolean' ? { enableRag } : {}),
    ...(owner ? { owner } : {}),
    ...(role ? { role } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(delegatesTo !== undefined ? { delegatesTo } : {}),
    ...(peers !== undefined ? { peers } : {}),
    ...(cv ? { cv } : {}),
    ...(escalationTarget ? { escalationTarget } : {}),
  };
}

function normalizeAgentsConfig(
  value: unknown,
  fallback: AgentsConfig,
): AgentsConfig {
  const raw = isRecord(value) ? value : {};
  const defaults = normalizeAgentDefaultsConfig(
    raw.defaults,
    fallback.defaults ?? {},
  );
  const listSource = Array.isArray(raw.list) ? raw.list : (fallback.list ?? []);
  const seen = new Set<string>();
  const list: AgentConfig[] = [];
  for (const entry of listSource) {
    const normalized = normalizeAgentConfig(entry);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    list.push(normalized);
  }
  if (!seen.has(DEFAULT_AGENT_ID)) {
    list.unshift({ id: DEFAULT_AGENT_ID });
    seen.add(DEFAULT_AGENT_ID);
  }
  validateAgentOrgChart(list);
  const defaultAgentId = normalizeString(
    raw.defaultAgentId,
    fallback.defaultAgentId ?? DEFAULT_AGENT_ID,
    { allowEmpty: false },
  );
  return {
    defaultAgentId: seen.has(defaultAgentId)
      ? defaultAgentId
      : DEFAULT_AGENT_ID,
    defaults,
    list,
  };
}

function normalizeRuntimePluginEntry(
  value: unknown,
  fallback?: RuntimePluginConfigEntry,
): RuntimePluginConfigEntry | null {
  if (!isRecord(value)) return null;
  const id = normalizeString(value.id, fallback?.id ?? '', {
    allowEmpty: false,
  });
  if (!id) return null;
  const config = isRecord(value.config)
    ? cloneConfig(value.config)
    : cloneConfig(fallback?.config ?? {});
  const pluginPath = normalizeString(value.path, fallback?.path ?? '', {
    allowEmpty: true,
  });
  return {
    id,
    enabled: normalizeBoolean(value.enabled, fallback?.enabled ?? true),
    ...(pluginPath ? { path: pluginPath } : {}),
    config,
  };
}

function normalizeRuntimePluginsConfig(
  value: unknown,
  fallback: RuntimePluginsConfig,
): RuntimePluginsConfig {
  const raw = isRecord(value) ? value : {};
  const listSource = Array.isArray(raw.list) ? raw.list : fallback.list;
  const list: RuntimePluginConfigEntry[] = [];
  const seen = new Set<string>();
  for (const entry of listSource) {
    const normalized = normalizeRuntimePluginEntry(entry);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    list.push(normalized);
  }
  return { list };
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue === 'string') {
      normalized[key] = rawValue;
      continue;
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      normalized[key] = String(rawValue);
    }
  }
  return normalized;
}

function normalizeMcpTransport(
  value: unknown,
  fallback: McpServerConfig['transport'],
): McpServerConfig['transport'] {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'stdio') return 'stdio';
  if (
    normalized === 'http' ||
    normalized === 'streamable-http' ||
    normalized === 'streamable_http'
  ) {
    return 'http';
  }
  if (normalized === 'sse') return 'sse';
  return fallback;
}

function normalizeMcpServerConfig(value: unknown): McpServerConfig | null {
  if (!isRecord(value)) return null;
  const transport = normalizeMcpTransport(
    value.transport ?? value.type,
    'stdio',
  );
  const command = normalizeString(value.command, '', { allowEmpty: true });
  const args = Array.isArray(value.args)
    ? normalizeStringArray(value.args, [])
    : undefined;
  const env = normalizeStringRecord(value.env);
  const cwd = normalizeString(value.cwd, '', { allowEmpty: true });
  const url = normalizeString(value.url, '', { allowEmpty: true });
  const headers = normalizeStringRecord(value.headers);
  const enabled = normalizeBoolean(value.enabled, true);

  if (transport === 'stdio' && !command) return null;
  if ((transport === 'http' || transport === 'sse') && !url) return null;

  return {
    transport,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    ...(url ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    enabled,
  };
}

function normalizeMcpServers(value: unknown): Record<string, McpServerConfig> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, McpServerConfig> = {};
  for (const [rawName, rawConfig] of Object.entries(value)) {
    const name = rawName.trim();
    if (!name) continue;
    const serverConfig = normalizeMcpServerConfig(rawConfig);
    if (!serverConfig) continue;
    normalized[name] = serverConfig;
  }
  return normalized;
}

function normalizeCodexModelArray(
  value: unknown,
  fallback: string[],
): string[] {
  const normalized = normalizeStringArray(value, fallback);
  if (
    normalized.length === LEGACY_SINGLE_CODEX_MODEL_LIST.length &&
    normalized.every(
      (model, index) => model === LEGACY_SINGLE_CODEX_MODEL_LIST[index],
    )
  ) {
    return [...DEFAULT_CODEX_MODEL_LIST];
  }
  return normalized;
}

function normalizePathForCompare(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

function isLegacyDefaultDbPath(value: string): boolean {
  const normalized = normalizePathForCompare(value);
  return (
    normalized === LEGACY_DEFAULT_DB_PATH ||
    normalized === `./${LEGACY_DEFAULT_DB_PATH}`
  );
}

function normalizeDbPath(value: unknown, fallback: string): string {
  const normalized = normalizeString(value, fallback, { allowEmpty: false });
  const expanded = expandHomePath(normalized);
  if (isLegacyDefaultDbPath(expanded)) return DEFAULT_DB_PATH;
  return expanded;
}

function normalizeDiscordGroupPolicy(
  value: unknown,
  fallback: DiscordGroupPolicy,
): DiscordGroupPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeDiscordSendPolicy(
  value: unknown,
  fallback: DiscordSendPolicy,
): DiscordSendPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeMSTeamsGroupPolicy(
  value: unknown,
  fallback: MSTeamsGroupPolicy,
): MSTeamsGroupPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeMSTeamsDmPolicy(
  value: unknown,
  fallback: MSTeamsDmPolicy,
): MSTeamsDmPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pairing') {
    return 'allowlist';
  }
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeMSTeamsReplyStyle(
  value: unknown,
  fallback: MSTeamsReplyStyle,
): MSTeamsReplyStyle {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'thread' || normalized === 'top-level') {
    return normalized;
  }
  if (normalized === 'top_level') return 'top-level';
  return fallback;
}

function normalizeWhatsAppDmPolicy(
  value: unknown,
  fallback: WhatsAppDmPolicy,
): WhatsAppDmPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'pairing' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeWhatsAppGroupPolicy(
  value: unknown,
  fallback: WhatsAppGroupPolicy,
): WhatsAppGroupPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeTelegramPolicy(
  value: unknown,
  fallback: TelegramDmPolicy,
): TelegramDmPolicy;
function normalizeTelegramPolicy(
  value: unknown,
  fallback: TelegramGroupPolicy,
): TelegramGroupPolicy;
function normalizeTelegramPolicy(
  value: unknown,
  fallback: TelegramDmPolicy | TelegramGroupPolicy,
): TelegramDmPolicy | TelegramGroupPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeSignalPolicy(
  value: unknown,
  fallback: SignalDmPolicy,
): SignalDmPolicy;
function normalizeSignalPolicy(
  value: unknown,
  fallback: SignalGroupPolicy,
): SignalGroupPolicy;
function normalizeSignalPolicy(
  value: unknown,
  fallback: SignalDmPolicy | SignalGroupPolicy,
): SignalDmPolicy | SignalGroupPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeSignalConfig(
  value: unknown,
  fallback: RuntimeSignalConfig,
): RuntimeSignalConfig {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    daemonUrl: normalizeString(raw.daemonUrl, fallback.daemonUrl, {
      allowEmpty: true,
    }),
    account: normalizeString(raw.account, fallback.account, {
      allowEmpty: true,
    }),
    dmPolicy: normalizeSignalPolicy(raw.dmPolicy, fallback.dmPolicy),
    groupPolicy: normalizeSignalPolicy(raw.groupPolicy, fallback.groupPolicy),
    allowFrom: normalizeStringArray(raw.allowFrom, fallback.allowFrom),
    groupAllowFrom: normalizeStringArray(
      raw.groupAllowFrom,
      fallback.groupAllowFrom,
    ),
    textChunkLimit: normalizeInteger(
      raw.textChunkLimit,
      fallback.textChunkLimit,
      {
        min: 200,
        max: 8_000,
      },
    ),
    reconnectIntervalMs: normalizeInteger(
      raw.reconnectIntervalMs,
      fallback.reconnectIntervalMs,
      {
        min: 500,
        max: 60_000,
      },
    ),
    outboundDelayMs: normalizeInteger(
      raw.outboundDelayMs,
      fallback.outboundDelayMs,
      {
        min: 0,
        max: 10_000,
      },
    ),
  };
}

function normalizeSlackGroupPolicy(
  value: unknown,
  fallback: SlackGroupPolicy,
): SlackGroupPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeSlackDmPolicy(
  value: unknown,
  fallback: SlackDmPolicy,
): SlackDmPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeSlackReplyStyle(
  value: unknown,
  fallback: SlackReplyStyle,
): SlackReplyStyle {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'thread' || normalized === 'top-level') {
    return normalized;
  }
  if (normalized === 'top_level') return 'top-level';
  return fallback;
}

function normalizeIMessageBackend(
  value: unknown,
  fallback: IMessageBackend,
): IMessageBackend {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'local' || normalized === 'bluebubbles') {
    return normalized;
  }
  return fallback;
}

function normalizeVoiceProvider(
  value: unknown,
  fallback: RuntimeVoiceProvider,
): RuntimeVoiceProvider {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'twilio') {
    return 'twilio';
  }
  return fallback;
}

function normalizeVoiceRelayTtsProvider(
  value: unknown,
  fallback: RuntimeVoiceRelayTtsProvider,
): RuntimeVoiceRelayTtsProvider {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'default' ||
    normalized === 'google' ||
    normalized === 'amazon'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeVoiceRelayTranscriptionProvider(
  value: unknown,
  fallback: RuntimeVoiceRelayTranscriptionProvider,
): RuntimeVoiceRelayTranscriptionProvider {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'default' ||
    normalized === 'google' ||
    normalized === 'deepgram'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeIMessageDmPolicy(
  value: unknown,
  fallback: IMessageDmPolicy,
): IMessageDmPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeIMessageGroupPolicy(
  value: unknown,
  fallback: IMessageGroupPolicy,
): IMessageGroupPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'allowlist' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeWhatsAppConfig(
  value: unknown,
  fallback: RuntimeWhatsAppConfig,
): RuntimeWhatsAppConfig {
  const raw = isRecord(value) ? value : {};
  return {
    dmPolicy: normalizeWhatsAppDmPolicy(raw.dmPolicy, fallback.dmPolicy),
    groupPolicy: normalizeWhatsAppGroupPolicy(
      raw.groupPolicy,
      fallback.groupPolicy,
    ),
    allowFrom: normalizeStringArray(raw.allowFrom, fallback.allowFrom),
    groupAllowFrom: normalizeStringArray(
      raw.groupAllowFrom,
      fallback.groupAllowFrom,
    ),
    textChunkLimit: normalizeInteger(
      raw.textChunkLimit,
      fallback.textChunkLimit,
      {
        min: 200,
        max: 4_000,
      },
    ),
    debounceMs: normalizeInteger(raw.debounceMs, fallback.debounceMs, {
      min: 0,
      max: 120_000,
    }),
    sendReadReceipts: normalizeBoolean(
      raw.sendReadReceipts,
      fallback.sendReadReceipts,
    ),
    ackReaction: normalizeString(raw.ackReaction, fallback.ackReaction, {
      allowEmpty: true,
    }),
    mediaMaxMb: normalizeInteger(raw.mediaMaxMb, fallback.mediaMaxMb, {
      min: 1,
      max: 100,
    }),
  };
}

function normalizeTelegramConfig(
  value: unknown,
  fallback: RuntimeTelegramConfig,
  opts?: {
    botToken?: unknown;
  },
): RuntimeTelegramConfig {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    botToken: normalizeString(
      opts?.botToken ?? raw.botToken,
      fallback.botToken,
      {
        allowEmpty: true,
      },
    ),
    pollIntervalMs: normalizeInteger(
      raw.pollIntervalMs,
      fallback.pollIntervalMs,
      {
        min: 0,
        max: 60_000,
      },
    ),
    dmPolicy: normalizeTelegramPolicy(raw.dmPolicy, fallback.dmPolicy),
    groupPolicy: normalizeTelegramPolicy(raw.groupPolicy, fallback.groupPolicy),
    allowFrom: normalizeStringArray(raw.allowFrom, fallback.allowFrom),
    groupAllowFrom: normalizeStringArray(
      raw.groupAllowFrom,
      fallback.groupAllowFrom,
    ),
    requireMention: normalizeBoolean(
      raw.requireMention,
      fallback.requireMention,
    ),
    textChunkLimit: normalizeInteger(
      raw.textChunkLimit,
      fallback.textChunkLimit,
      {
        min: 200,
        max: 4_000,
      },
    ),
    mediaMaxMb: normalizeInteger(raw.mediaMaxMb, fallback.mediaMaxMb, {
      min: 1,
      max: 100,
    }),
  };
}

function normalizeSlackConfig(
  value: unknown,
  fallback: RuntimeSlackConfig,
): RuntimeSlackConfig {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    groupPolicy: normalizeSlackGroupPolicy(
      raw.groupPolicy,
      fallback.groupPolicy,
    ),
    dmPolicy: normalizeSlackDmPolicy(raw.dmPolicy, fallback.dmPolicy),
    allowFrom: normalizeStringArray(raw.allowFrom, fallback.allowFrom),
    groupAllowFrom: normalizeStringArray(
      raw.groupAllowFrom,
      fallback.groupAllowFrom,
    ),
    requireMention: normalizeBoolean(
      raw.requireMention,
      fallback.requireMention,
    ),
    textChunkLimit: normalizeInteger(
      raw.textChunkLimit,
      fallback.textChunkLimit,
      {
        min: 200,
        max: 40_000,
      },
    ),
    replyStyle: normalizeSlackReplyStyle(raw.replyStyle, fallback.replyStyle),
    mediaMaxMb: normalizeInteger(raw.mediaMaxMb, fallback.mediaMaxMb, {
      min: 1,
      max: 100,
    }),
  };
}

function normalizeVoiceConfig(
  value: unknown,
  fallback: RuntimeVoiceConfig,
  opts?: {
    authToken?: unknown;
  },
): RuntimeVoiceConfig {
  const raw = isRecord(value) ? value : {};
  const rawTwilio = isRecord(raw.twilio) ? raw.twilio : {};
  const rawRelay = isRecord(raw.relay) ? raw.relay : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    provider: normalizeVoiceProvider(raw.provider, fallback.provider),
    twilio: {
      accountSid: normalizeString(
        rawTwilio.accountSid,
        fallback.twilio.accountSid,
        { allowEmpty: true },
      ),
      authToken: normalizeString(
        opts?.authToken ?? rawTwilio.authToken,
        fallback.twilio.authToken,
        { allowEmpty: true },
      ),
      fromNumber: normalizeString(
        rawTwilio.fromNumber,
        fallback.twilio.fromNumber,
        { allowEmpty: true },
      ),
    },
    relay: {
      ttsProvider: normalizeVoiceRelayTtsProvider(
        rawRelay.ttsProvider,
        fallback.relay.ttsProvider,
      ),
      voice: normalizeString(rawRelay.voice, fallback.relay.voice, {
        allowEmpty: true,
      }),
      transcriptionProvider: normalizeVoiceRelayTranscriptionProvider(
        rawRelay.transcriptionProvider,
        fallback.relay.transcriptionProvider,
      ),
      language: normalizeString(rawRelay.language, fallback.relay.language, {
        allowEmpty: false,
      }),
      interruptible: normalizeBoolean(
        rawRelay.interruptible,
        fallback.relay.interruptible,
      ),
      welcomeGreeting: normalizeString(
        rawRelay.welcomeGreeting,
        fallback.relay.welcomeGreeting,
        { allowEmpty: false },
      ),
    },
    webhookPath: normalizeApiPath(raw.webhookPath, fallback.webhookPath),
    maxConcurrentCalls: normalizeInteger(
      raw.maxConcurrentCalls,
      fallback.maxConcurrentCalls,
      {
        min: 1,
        max: 128,
      },
    ),
  };
}

function normalizeChannelInstructionsConfig(
  value: unknown,
  fallback: RuntimeChannelInstructionsConfig,
): RuntimeChannelInstructionsConfig {
  const raw = isRecord(value) ? value : {};
  return {
    discord: normalizeString(raw.discord, fallback.discord, {
      allowEmpty: true,
    }),
    msteams: normalizeString(raw.msteams, fallback.msteams, {
      allowEmpty: true,
    }),
    signal: normalizeString(raw.signal, fallback.signal, { allowEmpty: true }),
    slack: normalizeString(raw.slack, fallback.slack, { allowEmpty: true }),
    telegram: normalizeString(raw.telegram, fallback.telegram, {
      allowEmpty: true,
    }),
    voice: normalizeString(raw.voice, fallback.voice, { allowEmpty: true }),
    whatsapp: normalizeString(raw.whatsapp, fallback.whatsapp, {
      allowEmpty: true,
    }),
    email: normalizeString(raw.email, fallback.email, { allowEmpty: true }),
    imessage: normalizeString(raw.imessage, fallback.imessage, {
      allowEmpty: true,
    }),
  };
}

function normalizeIMessageConfig(
  value: unknown,
  fallback: RuntimeIMessageConfig,
  opts?: {
    password?: unknown;
  },
): RuntimeIMessageConfig {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    backend: normalizeIMessageBackend(raw.backend, fallback.backend),
    cliPath: normalizeString(raw.cliPath, fallback.cliPath, {
      allowEmpty: false,
    }),
    dbPath: normalizeString(raw.dbPath, fallback.dbPath, {
      allowEmpty: false,
    }),
    pollIntervalMs: normalizeInteger(
      raw.pollIntervalMs,
      fallback.pollIntervalMs,
      {
        min: 250,
        max: 120_000,
      },
    ),
    serverUrl: normalizeBaseUrl(raw.serverUrl, fallback.serverUrl),
    password: normalizeString(
      opts?.password ?? raw.password,
      fallback.password,
      {
        allowEmpty: true,
      },
    ),
    webhookPath: normalizeString(raw.webhookPath, fallback.webhookPath, {
      allowEmpty: false,
    }),
    allowPrivateNetwork: normalizeBoolean(
      raw.allowPrivateNetwork,
      fallback.allowPrivateNetwork,
    ),
    dmPolicy: normalizeIMessageDmPolicy(raw.dmPolicy, fallback.dmPolicy),
    groupPolicy: normalizeIMessageGroupPolicy(
      raw.groupPolicy,
      fallback.groupPolicy,
    ),
    allowFrom: normalizeStringArray(raw.allowFrom, fallback.allowFrom),
    groupAllowFrom: normalizeStringArray(
      raw.groupAllowFrom,
      fallback.groupAllowFrom,
    ),
    textChunkLimit: normalizeInteger(
      raw.textChunkLimit,
      fallback.textChunkLimit,
      {
        min: 200,
        max: 4_000,
      },
    ),
    debounceMs: normalizeInteger(raw.debounceMs, fallback.debounceMs, {
      min: 0,
      max: 120_000,
    }),
    mediaMaxMb: normalizeInteger(raw.mediaMaxMb, fallback.mediaMaxMb, {
      min: 1,
      max: 100,
    }),
  };
}

function normalizeEmailConfig(
  value: unknown,
  fallback: RuntimeEmailConfig,
  opts?: {
    password?: unknown;
  },
): RuntimeEmailConfig {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    imapHost: normalizeString(raw.imapHost, fallback.imapHost, {
      allowEmpty: true,
    }),
    imapPort: normalizeInteger(raw.imapPort, fallback.imapPort, {
      min: 1,
      max: 65_535,
    }),
    imapSecure: normalizeBoolean(raw.imapSecure, fallback.imapSecure),
    smtpHost: normalizeString(raw.smtpHost, fallback.smtpHost, {
      allowEmpty: true,
    }),
    smtpPort: normalizeInteger(raw.smtpPort, fallback.smtpPort, {
      min: 1,
      max: 65_535,
    }),
    smtpSecure: normalizeBoolean(raw.smtpSecure, fallback.smtpSecure),
    address: normalizeString(raw.address, fallback.address, {
      allowEmpty: true,
    }),
    password: normalizeString(
      opts?.password ?? raw.password,
      fallback.password,
      {
        allowEmpty: true,
      },
    ),
    pollIntervalMs: normalizeInteger(
      raw.pollIntervalMs,
      fallback.pollIntervalMs,
      {
        min: 1_000,
        max: 3_600_000,
      },
    ),
    folders: normalizeStringArray(raw.folders, fallback.folders),
    allowFrom: normalizeStringArray(raw.allowFrom, fallback.allowFrom),
    textChunkLimit: normalizeInteger(
      raw.textChunkLimit,
      fallback.textChunkLimit,
      {
        min: 500,
        max: 200_000,
      },
    ),
    mediaMaxMb: normalizeInteger(raw.mediaMaxMb, fallback.mediaMaxMb, {
      min: 1,
      max: 100,
    }),
  };
}

function normalizeDiscordCommandMode(
  value: unknown,
  fallback: DiscordCommandMode,
): DiscordCommandMode {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'public' || normalized === 'restricted') {
    return normalized;
  }
  return fallback;
}

function normalizeDiscordChannelMode(
  value: unknown,
  fallback: DiscordChannelMode,
): DiscordChannelMode {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'mention' || normalized === 'free')
    return normalized;
  if (normalized === 'free-response' || normalized === 'free_response')
    return 'free';
  return fallback;
}

function normalizeDiscordTypingMode(
  value: unknown,
  fallback: DiscordTypingMode,
): DiscordTypingMode {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'instant' ||
    normalized === 'thinking' ||
    normalized === 'streaming' ||
    normalized === 'never'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeDiscordHumanDelayMode(
  value: unknown,
  fallback: DiscordHumanDelayMode,
): DiscordHumanDelayMode {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'off' ||
    normalized === 'natural' ||
    normalized === 'custom'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeDiscordAckReactionScope(
  value: unknown,
  fallback: DiscordAckReactionScope,
): DiscordAckReactionScope {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'all' ||
    normalized === 'group-mentions' ||
    normalized === 'direct' ||
    normalized === 'off'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeDiscordPresenceActivityType(
  value: unknown,
  fallback: DiscordPresenceActivityType,
): DiscordPresenceActivityType {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'playing' ||
    normalized === 'watching' ||
    normalized === 'listening' ||
    normalized === 'competing' ||
    normalized === 'custom'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeDiscordHumanDelayConfig(
  value: unknown,
  fallback: RuntimeDiscordHumanDelayConfig,
): RuntimeDiscordHumanDelayConfig {
  const raw = isRecord(value) ? value : {};
  const mode = normalizeDiscordHumanDelayMode(raw.mode, fallback.mode);
  const minMs = normalizeInteger(raw.minMs, fallback.minMs, {
    min: 0,
    max: 120_000,
  });
  const maxMsRaw = normalizeInteger(raw.maxMs, fallback.maxMs, {
    min: 0,
    max: 120_000,
  });
  const maxMs = Math.max(minMs, maxMsRaw);
  return { mode, minMs, maxMs };
}

function normalizeDiscordPresenceConfig(
  value: unknown,
  fallback: RuntimeDiscordPresenceConfig,
): RuntimeDiscordPresenceConfig {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    intervalMs: normalizeInteger(raw.intervalMs, fallback.intervalMs, {
      min: 5_000,
      max: 300_000,
    }),
    healthyText: normalizeString(raw.healthyText, fallback.healthyText, {
      allowEmpty: false,
    }),
    degradedText: normalizeString(raw.degradedText, fallback.degradedText, {
      allowEmpty: false,
    }),
    exhaustedText: normalizeString(raw.exhaustedText, fallback.exhaustedText, {
      allowEmpty: false,
    }),
    activityType: normalizeDiscordPresenceActivityType(
      raw.activityType,
      fallback.activityType,
    ),
  };
}

function normalizeDiscordLifecycleReactionsConfig(
  value: unknown,
  fallback: RuntimeDiscordLifecycleReactionsConfig,
): RuntimeDiscordLifecycleReactionsConfig {
  const raw = isRecord(value) ? value : {};
  const rawPhases = isRecord(raw.phases) ? raw.phases : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    removeOnComplete: normalizeBoolean(
      raw.removeOnComplete,
      fallback.removeOnComplete,
    ),
    phases: {
      queued: normalizeString(rawPhases.queued, fallback.phases.queued, {
        allowEmpty: false,
      }),
      thinking: normalizeString(rawPhases.thinking, fallback.phases.thinking, {
        allowEmpty: false,
      }),
      toolUse: normalizeString(rawPhases.toolUse, fallback.phases.toolUse, {
        allowEmpty: false,
      }),
      streaming: normalizeString(
        rawPhases.streaming,
        fallback.phases.streaming,
        { allowEmpty: false },
      ),
      done: normalizeString(rawPhases.done, fallback.phases.done, {
        allowEmpty: false,
      }),
      error: normalizeString(rawPhases.error, fallback.phases.error, {
        allowEmpty: false,
      }),
    },
  };
}

function normalizeDiscordChannelConfig(
  value: unknown,
  fallback: RuntimeDiscordChannelConfig,
  defaultMode: DiscordChannelMode,
): RuntimeDiscordChannelConfig | null {
  const channelFallback = {
    ...fallback,
    mode: fallback.mode || defaultMode,
  };

  if (typeof value === 'string') {
    return { mode: normalizeDiscordChannelMode(value, channelFallback.mode) };
  }
  if (!isRecord(value)) return null;

  const channelConfig: RuntimeDiscordChannelConfig = {
    mode: normalizeDiscordChannelMode(value.mode, channelFallback.mode),
  };

  if (
    value.typingMode !== undefined ||
    channelFallback.typingMode !== undefined
  ) {
    channelConfig.typingMode = normalizeDiscordTypingMode(
      value.typingMode,
      channelFallback.typingMode ?? DEFAULT_RUNTIME_CONFIG.discord.typingMode,
    );
  }
  if (
    value.debounceMs !== undefined ||
    channelFallback.debounceMs !== undefined
  ) {
    channelConfig.debounceMs = normalizeInteger(
      value.debounceMs,
      channelFallback.debounceMs ?? DEFAULT_RUNTIME_CONFIG.discord.debounceMs,
      { min: 0, max: 120_000 },
    );
  }
  if (
    value.ackReaction !== undefined ||
    channelFallback.ackReaction !== undefined
  ) {
    channelConfig.ackReaction = normalizeString(
      value.ackReaction,
      channelFallback.ackReaction ?? DEFAULT_RUNTIME_CONFIG.discord.ackReaction,
      { allowEmpty: false },
    );
  }
  if (
    value.ackReactionScope !== undefined ||
    channelFallback.ackReactionScope !== undefined
  ) {
    channelConfig.ackReactionScope = normalizeDiscordAckReactionScope(
      value.ackReactionScope,
      channelFallback.ackReactionScope ??
        DEFAULT_RUNTIME_CONFIG.discord.ackReactionScope,
    );
  }
  if (
    value.removeAckAfterReply !== undefined ||
    channelFallback.removeAckAfterReply !== undefined
  ) {
    channelConfig.removeAckAfterReply = normalizeBoolean(
      value.removeAckAfterReply,
      channelFallback.removeAckAfterReply ??
        DEFAULT_RUNTIME_CONFIG.discord.removeAckAfterReply,
    );
  }
  if (
    value.humanDelay !== undefined ||
    channelFallback.humanDelay !== undefined
  ) {
    channelConfig.humanDelay = normalizeDiscordHumanDelayConfig(
      value.humanDelay,
      channelFallback.humanDelay ?? DEFAULT_RUNTIME_CONFIG.discord.humanDelay,
    );
  }
  if (
    value.rateLimitPerUser !== undefined ||
    channelFallback.rateLimitPerUser !== undefined
  ) {
    channelConfig.rateLimitPerUser = normalizeInteger(
      value.rateLimitPerUser,
      channelFallback.rateLimitPerUser ??
        DEFAULT_RUNTIME_CONFIG.discord.rateLimitPerUser,
      { min: 0, max: 300 },
    );
  }
  if (
    value.suppressPatterns !== undefined ||
    channelFallback.suppressPatterns !== undefined
  ) {
    channelConfig.suppressPatterns = normalizeStringArray(
      value.suppressPatterns,
      channelFallback.suppressPatterns ??
        DEFAULT_RUNTIME_CONFIG.discord.suppressPatterns,
    );
  }
  if (
    value.maxConcurrentPerChannel !== undefined ||
    channelFallback.maxConcurrentPerChannel !== undefined
  ) {
    channelConfig.maxConcurrentPerChannel = normalizeInteger(
      value.maxConcurrentPerChannel,
      channelFallback.maxConcurrentPerChannel ??
        DEFAULT_RUNTIME_CONFIG.discord.maxConcurrentPerChannel,
      { min: 1, max: 16 },
    );
  }
  if (
    value.allowSend !== undefined ||
    channelFallback.allowSend !== undefined
  ) {
    channelConfig.allowSend = normalizeBoolean(
      value.allowSend,
      channelFallback.allowSend ?? true,
    );
  }
  if (
    value.sendAllowedUserIds !== undefined ||
    channelFallback.sendAllowedUserIds !== undefined
  ) {
    channelConfig.sendAllowedUserIds = normalizeStringArray(
      value.sendAllowedUserIds,
      channelFallback.sendAllowedUserIds ?? [],
    );
  }
  if (
    value.sendAllowedRoleIds !== undefined ||
    channelFallback.sendAllowedRoleIds !== undefined
  ) {
    channelConfig.sendAllowedRoleIds = normalizeStringArray(
      value.sendAllowedRoleIds,
      channelFallback.sendAllowedRoleIds ?? [],
    );
  }

  return channelConfig;
}

function normalizeDiscordGuildConfig(
  value: unknown,
  fallback: RuntimeDiscordGuildConfig,
): RuntimeDiscordGuildConfig {
  if (!isRecord(value)) return fallback;
  const defaultMode = normalizeDiscordChannelMode(
    value.defaultMode,
    fallback.defaultMode,
  );
  const rawChannels = isRecord(value.channels) ? value.channels : {};
  const channels: Record<string, RuntimeDiscordChannelConfig> = {};
  for (const [rawChannelId, rawChannelConfig] of Object.entries(rawChannels)) {
    const channelId = rawChannelId.trim();
    if (!channelId) continue;
    const fallbackChannel = fallback.channels[channelId] ?? {
      mode: defaultMode,
    };
    const channelConfig = normalizeDiscordChannelConfig(
      rawChannelConfig,
      fallbackChannel,
      defaultMode,
    );
    if (!channelConfig) continue;
    channels[channelId] = channelConfig;
  }

  const sendAllowedUserIds = normalizeStringArray(
    value.sendAllowedUserIds,
    fallback.sendAllowedUserIds ?? [],
  );
  const sendAllowedRoleIds = normalizeStringArray(
    value.sendAllowedRoleIds,
    fallback.sendAllowedRoleIds ?? [],
  );

  return {
    defaultMode,
    channels,
    ...(sendAllowedUserIds.length > 0 ? { sendAllowedUserIds } : {}),
    ...(sendAllowedRoleIds.length > 0 ? { sendAllowedRoleIds } : {}),
  };
}

function normalizeDiscordGuildMap(
  value: unknown,
  fallback: Record<string, RuntimeDiscordGuildConfig>,
): Record<string, RuntimeDiscordGuildConfig> {
  if (!isRecord(value)) return fallback;
  const guilds: Record<string, RuntimeDiscordGuildConfig> = {};
  for (const [rawGuildId, rawGuildConfig] of Object.entries(value)) {
    const guildId = rawGuildId.trim();
    if (!guildId) continue;
    const fallbackGuild = fallback[guildId] ?? {
      defaultMode: 'mention',
      channels: {},
    };
    guilds[guildId] = normalizeDiscordGuildConfig(
      rawGuildConfig,
      fallbackGuild,
    );
  }
  return guilds;
}

function normalizeMSTeamsWebhookConfig(
  value: unknown,
  fallback: RuntimeMSTeamsWebhookConfig,
): RuntimeMSTeamsWebhookConfig {
  const raw = isRecord(value) ? value : {};
  return {
    port: normalizeInteger(raw.port, fallback.port, {
      min: 1,
      max: 65_535,
    }),
    path: normalizeString(raw.path, fallback.path, { allowEmpty: false }),
  };
}

function normalizeMSTeamsChannelConfig(
  value: unknown,
  fallback: RuntimeMSTeamsChannelConfig,
): RuntimeMSTeamsChannelConfig | null {
  if (!isRecord(value)) return null;
  const config: RuntimeMSTeamsChannelConfig = {};

  if (
    value.requireMention !== undefined ||
    fallback.requireMention !== undefined
  ) {
    config.requireMention = normalizeBoolean(
      value.requireMention,
      fallback.requireMention ?? DEFAULT_RUNTIME_CONFIG.msteams.requireMention,
    );
  }
  if (value.tools !== undefined || fallback.tools !== undefined) {
    config.tools = normalizeStringArray(value.tools, fallback.tools ?? []);
  }
  if (value.replyStyle !== undefined || fallback.replyStyle !== undefined) {
    config.replyStyle = normalizeMSTeamsReplyStyle(
      value.replyStyle,
      fallback.replyStyle ?? DEFAULT_RUNTIME_CONFIG.msteams.replyStyle,
    );
  }
  if (value.groupPolicy !== undefined || fallback.groupPolicy !== undefined) {
    config.groupPolicy = normalizeMSTeamsGroupPolicy(
      value.groupPolicy,
      fallback.groupPolicy ?? DEFAULT_RUNTIME_CONFIG.msteams.groupPolicy,
    );
  }
  if (value.allowFrom !== undefined || fallback.allowFrom !== undefined) {
    config.allowFrom = normalizeStringArray(
      value.allowFrom,
      fallback.allowFrom ?? [],
    );
  }

  return config;
}

function normalizeMSTeamsTeamConfig(
  value: unknown,
  fallback: RuntimeMSTeamsTeamConfig,
): RuntimeMSTeamsTeamConfig {
  if (!isRecord(value)) return fallback;
  const rawChannels = isRecord(value.channels) ? value.channels : {};
  const channels: Record<string, RuntimeMSTeamsChannelConfig> = {};
  for (const [rawChannelId, rawChannelConfig] of Object.entries(rawChannels)) {
    const channelId = rawChannelId.trim();
    if (!channelId) continue;
    const normalized = normalizeMSTeamsChannelConfig(
      rawChannelConfig,
      fallback.channels[channelId] ?? {},
    );
    if (!normalized) continue;
    channels[channelId] = normalized;
  }

  const requireMention = normalizeBoolean(
    value.requireMention,
    fallback.requireMention ?? DEFAULT_RUNTIME_CONFIG.msteams.requireMention,
  );
  const tools = normalizeStringArray(value.tools, fallback.tools ?? []);
  const replyStyle = normalizeMSTeamsReplyStyle(
    value.replyStyle,
    fallback.replyStyle ?? DEFAULT_RUNTIME_CONFIG.msteams.replyStyle,
  );
  const groupPolicy = normalizeMSTeamsGroupPolicy(
    value.groupPolicy,
    fallback.groupPolicy ?? DEFAULT_RUNTIME_CONFIG.msteams.groupPolicy,
  );
  const allowFrom = normalizeStringArray(
    value.allowFrom,
    fallback.allowFrom ?? [],
  );

  return {
    requireMention,
    ...(tools.length > 0 ? { tools } : {}),
    replyStyle,
    groupPolicy,
    ...(allowFrom.length > 0 ? { allowFrom } : {}),
    channels,
  };
}

function normalizeMSTeamsTeamMap(
  value: unknown,
  fallback: Record<string, RuntimeMSTeamsTeamConfig>,
): Record<string, RuntimeMSTeamsTeamConfig> {
  if (!isRecord(value)) return fallback;
  const teams: Record<string, RuntimeMSTeamsTeamConfig> = {};
  for (const [rawTeamId, rawTeamConfig] of Object.entries(value)) {
    const teamId = rawTeamId.trim();
    if (!teamId) continue;
    teams[teamId] = normalizeMSTeamsTeamConfig(
      rawTeamConfig,
      fallback[teamId] ?? {
        channels: {},
      },
    );
  }
  return teams;
}

function normalizeMSTeamsConfig(
  value: unknown,
  fallback: RuntimeMSTeamsConfig,
): RuntimeMSTeamsConfig {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    appId: normalizeString(raw.appId, fallback.appId, { allowEmpty: true }),
    tenantId: normalizeString(raw.tenantId, fallback.tenantId, {
      allowEmpty: true,
    }),
    webhook: normalizeMSTeamsWebhookConfig(raw.webhook, fallback.webhook),
    groupPolicy: normalizeMSTeamsGroupPolicy(
      raw.groupPolicy,
      fallback.groupPolicy,
    ),
    dmPolicy: normalizeMSTeamsDmPolicy(raw.dmPolicy, fallback.dmPolicy),
    allowFrom: normalizeStringArray(raw.allowFrom, fallback.allowFrom),
    teams: normalizeMSTeamsTeamMap(raw.teams, fallback.teams),
    requireMention: normalizeBoolean(
      raw.requireMention,
      fallback.requireMention,
    ),
    textChunkLimit: normalizeInteger(
      raw.textChunkLimit,
      fallback.textChunkLimit,
      {
        min: 200,
        max: 20_000,
      },
    ),
    replyStyle: normalizeMSTeamsReplyStyle(raw.replyStyle, fallback.replyStyle),
    mediaMaxMb: normalizeInteger(raw.mediaMaxMb, fallback.mediaMaxMb, {
      min: 1,
      max: 100,
    }),
    dangerouslyAllowNameMatching: normalizeBoolean(
      raw.dangerouslyAllowNameMatching,
      fallback.dangerouslyAllowNameMatching,
    ),
    mediaAllowHosts: normalizeStringArray(
      raw.mediaAllowHosts,
      fallback.mediaAllowHosts,
    ),
    mediaAuthAllowHosts: normalizeStringArray(
      raw.mediaAuthAllowHosts,
      fallback.mediaAuthAllowHosts,
    ),
  };
}

function normalizeSchedulerScheduleKind(
  value: unknown,
  fallback: SchedulerScheduleKind,
): SchedulerScheduleKind {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'at' ||
    normalized === 'every' ||
    normalized === 'cron' ||
    normalized === 'one_shot'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeSchedulerActionKind(
  value: unknown,
  fallback: SchedulerActionKind,
): SchedulerActionKind {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'agent_turn' || normalized === 'system_event')
    return normalized;
  return fallback;
}

function normalizeSchedulerDeliveryKind(
  value: unknown,
  fallback: SchedulerDeliveryKind,
): SchedulerDeliveryKind {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'channel' ||
    normalized === 'last-channel' ||
    normalized === 'webhook'
  )
    return normalized;
  return fallback;
}

export function normalizeSchedulerBoardStatus(
  value: unknown,
): SchedulerBoardStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (SCHEDULER_BOARD_STATUS_SET.has(normalized)) {
    return normalized as SchedulerBoardStatus;
  }
  return undefined;
}

export function parseSchedulerBoardStatus(
  value: unknown,
  label = 'Scheduler board status',
): SchedulerBoardStatus | undefined {
  const trimmed =
    value === null || value === undefined ? '' : String(value).trim();
  if (!trimmed) return undefined;

  const normalized = normalizeSchedulerBoardStatus(trimmed);
  if (normalized) return normalized;

  throw new Error(
    `${label} must be \`backlog\`, \`in_progress\`, \`review\`, \`done\`, or \`cancelled\`.`,
  );
}

function normalizeSchedulerJobList(
  value: unknown,
  fallback: RuntimeSchedulerJob[],
): RuntimeSchedulerJob[] {
  if (!Array.isArray(value)) return fallback;
  const jobs: RuntimeSchedulerJob[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const jobId = normalizeString(item.id, '', { allowEmpty: false });
    if (!jobId) continue;

    const rawSchedule = isRecord(item.schedule) ? item.schedule : {};
    const rawAction = isRecord(item.action) ? item.action : {};
    const rawDelivery = isRecord(item.delivery) ? item.delivery : {};

    const scheduleKind = normalizeSchedulerScheduleKind(
      rawSchedule.kind,
      'cron',
    );
    const everyMs =
      scheduleKind === 'every'
        ? normalizeInteger(rawSchedule.everyMs, 60_000, {
            min: 10_000,
            max: 86_400_000,
          })
        : null;
    const atRaw =
      scheduleKind === 'at'
        ? normalizeString(rawSchedule.at, '', { allowEmpty: false })
        : '';
    const atIso =
      scheduleKind === 'at'
        ? (() => {
            const parsed = new Date(atRaw);
            return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
          })()
        : null;
    const expr =
      scheduleKind === 'cron'
        ? normalizeString(rawSchedule.expr, '', { allowEmpty: false })
        : '';
    const maxRetries =
      scheduleKind === 'one_shot'
        ? normalizeInteger(item.maxRetries, DEFAULT_ONE_SHOT_MAX_RETRIES, {
            min: 0,
            max: 100,
          })
        : null;
    if (scheduleKind === 'at' && !atIso) continue;
    if (scheduleKind === 'cron' && !expr) continue;

    const deliveryKind = normalizeSchedulerDeliveryKind(
      rawDelivery.kind,
      'channel',
    );
    const to = normalizeString(rawDelivery.to, '', { allowEmpty: true });
    const webhookUrl = normalizeString(
      rawDelivery.webhookUrl ?? rawDelivery.url,
      '',
      { allowEmpty: true },
    );
    if (deliveryKind === 'channel' && !to) continue;
    if (deliveryKind === 'webhook' && !webhookUrl) continue;
    const name = normalizeString(item.name, '', { allowEmpty: true });
    const description = normalizeString(item.description, '', {
      allowEmpty: true,
    });
    const actionMessage =
      normalizeString(rawAction.message, '', {
        allowEmpty: true,
      }) || description;
    if (!actionMessage) continue;
    const agentId = normalizeString(item.agentId, '', { allowEmpty: false });
    const boardStatus = normalizeSchedulerBoardStatus(item.boardStatus);

    jobs.push({
      id: jobId,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(agentId ? { agentId } : {}),
      ...(boardStatus ? { boardStatus } : {}),
      ...(maxRetries != null ? { maxRetries } : {}),
      schedule: {
        kind: scheduleKind,
        at: scheduleKind === 'at' ? atIso : null,
        everyMs,
        expr: scheduleKind === 'cron' ? expr : null,
        tz: normalizeString(rawSchedule.tz, '', { allowEmpty: true }),
      },
      action: {
        kind: normalizeSchedulerActionKind(rawAction.kind, 'agent_turn'),
        message: actionMessage,
      },
      delivery: {
        kind: deliveryKind,
        channel: normalizeString(rawDelivery.channel, 'discord', {
          allowEmpty: true,
        }),
        to,
        webhookUrl,
      },
      enabled: normalizeBoolean(item.enabled, true),
    });
  }
  return jobs;
}

function normalizeLogLevel(value: unknown, fallback: LogLevel): LogLevel {
  const normalized = normalizeString(value, fallback, {
    allowEmpty: false,
  }).toLowerCase();
  if (KNOWN_LOG_LEVELS.has(normalized)) return normalized as LogLevel;
  return fallback;
}

function normalizeBaseUrl(value: unknown, fallback: string): string {
  const candidate = normalizeString(value, fallback, { allowEmpty: false });
  return candidate.replace(/\/+$/, '') || fallback;
}

function migrateProviderBaseUrl(params: {
  provider: string;
  baseUrl: string;
  retired: ReadonlySet<string>;
  nextDefault: string;
}): string {
  if (params.retired.has(params.baseUrl)) {
    console.warn(
      `[runtime-config] migrating ${params.provider} baseUrl ${params.baseUrl} -> ${params.nextDefault}`,
    );
    return params.nextDefault;
  }
  return params.baseUrl;
}

const RETIRED_KILO_BASE_URLS = new Set<string>([
  'https://api.kilocode.ai/v1',
  'https://api.kilocode.ai',
  'http://api.kilocode.ai/v1',
  'http://api.kilocode.ai',
]);

function migrateKiloBaseUrl(baseUrl: string): string {
  return migrateProviderBaseUrl({
    provider: 'kilo',
    baseUrl,
    retired: RETIRED_KILO_BASE_URLS,
    nextDefault: DEFAULT_RUNTIME_CONFIG.kilo.baseUrl,
  });
}

const RETIRED_KIMI_BASE_URLS = new Set<string>([
  'https://api.kimi.com/coding/v1',
  'https://api.kimi.com/coding',
  'https://api.kimi.com/v1',
  'https://api.kimi.com',
  'http://api.kimi.com/coding/v1',
]);

function migrateKimiBaseUrl(baseUrl: string): string {
  return migrateProviderBaseUrl({
    provider: 'kimi',
    baseUrl,
    retired: RETIRED_KIMI_BASE_URLS,
    nextDefault: DEFAULT_RUNTIME_CONFIG.kimi.baseUrl,
  });
}

function normalizeApiPath(value: unknown, fallback: string): string {
  const normalized = normalizeString(value, fallback, {
    allowEmpty: false,
    trim: true,
  });
  if (/^https?:\/\//i.test(normalized)) {
    return normalized.replace(/\/+$/, '');
  }
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return prefixed.replace(/\/{2,}/g, '/');
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function getSecretInputFromSource(
  source: Record<string, unknown>,
  secretPath: RuntimeConfigSecretInputPath,
): unknown {
  if (secretPath === 'ops.webApiToken') {
    const ops = isRecord(source.ops) ? source.ops : null;
    return ops && hasOwn(ops, 'webApiToken') ? ops.webApiToken : undefined;
  }
  if (secretPath === 'ops.gatewayApiToken') {
    const ops = isRecord(source.ops) ? source.ops : null;
    return ops && hasOwn(ops, 'gatewayApiToken')
      ? ops.gatewayApiToken
      : undefined;
  }
  if (secretPath === 'email.password') {
    const email = isRecord(source.email) ? source.email : null;
    return email && hasOwn(email, 'password') ? email.password : undefined;
  }
  if (secretPath === 'imessage.password') {
    const imessage = isRecord(source.imessage) ? source.imessage : null;
    return imessage && hasOwn(imessage, 'password')
      ? imessage.password
      : undefined;
  }
  if (secretPath === 'telegram.botToken') {
    const telegram = isRecord(source.telegram) ? source.telegram : null;
    return telegram && hasOwn(telegram, 'botToken')
      ? telegram.botToken
      : undefined;
  }
  if (secretPath === 'voice.twilio.authToken') {
    const voice = isRecord(source.voice) ? source.voice : null;
    const twilio = voice && isRecord(voice.twilio) ? voice.twilio : null;
    return twilio && hasOwn(twilio, 'authToken') ? twilio.authToken : undefined;
  }

  const local = isRecord(source.local) ? source.local : null;
  const backends = local && isRecord(local.backends) ? local.backends : null;
  const vllm = backends && isRecord(backends.vllm) ? backends.vllm : null;
  return vllm && hasOwn(vllm, 'apiKey') ? vllm.apiKey : undefined;
}

function setSecretInputOnSource(
  source: Record<string, unknown>,
  secretPath: RuntimeConfigSecretInputPath,
  value: SecretInput | '',
): void {
  if (
    secretPath === 'ops.webApiToken' ||
    secretPath === 'ops.gatewayApiToken'
  ) {
    const ops = isRecord(source.ops) ? source.ops : {};
    source.ops = ops;
    ops[secretPath === 'ops.webApiToken' ? 'webApiToken' : 'gatewayApiToken'] =
      value;
    return;
  }
  if (secretPath === 'email.password') {
    const email = isRecord(source.email) ? source.email : {};
    source.email = email;
    email.password = value;
    return;
  }
  if (secretPath === 'imessage.password') {
    const imessage = isRecord(source.imessage) ? source.imessage : {};
    source.imessage = imessage;
    imessage.password = value;
    return;
  }
  if (secretPath === 'telegram.botToken') {
    const telegram = isRecord(source.telegram) ? source.telegram : {};
    source.telegram = telegram;
    telegram.botToken = value;
    return;
  }
  if (secretPath === 'voice.twilio.authToken') {
    const voice = isRecord(source.voice) ? source.voice : {};
    source.voice = voice;
    const twilio = isRecord(voice.twilio) ? voice.twilio : {};
    voice.twilio = twilio;
    twilio.authToken = value;
    return;
  }

  const local = isRecord(source.local) ? source.local : {};
  source.local = local;
  const backends = isRecord(local.backends) ? local.backends : {};
  local.backends = backends;
  const vllm = isRecord(backends.vllm) ? backends.vllm : {};
  backends.vllm = vllm;
  vllm.apiKey = value;
}

function preserveSecretInputs(
  serializable: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const secretPath of SECRET_INPUT_PATHS) {
    const sourceValue = getSecretInputFromSource(source, secretPath);
    if (!isSecretRefInput(sourceValue)) continue;
    setSecretInputOnSource(serializable, secretPath, cloneConfig(sourceValue));
  }
}

function resolveConfiguredSecretInput(
  value: unknown,
  opts: {
    path: RuntimeConfigSecretInputPath;
    required?: boolean;
  },
): unknown {
  return resolveSecretInput(value, {
    path: opts.path,
    required: opts.required,
  });
}

function normalizeHttpHeaderName(
  value: unknown,
  fallback: string,
  opts?: { allowEmpty?: boolean },
): string {
  const normalized = normalizeString(value, fallback, {
    allowEmpty: opts?.allowEmpty ?? false,
  });
  if (!normalized) return normalized;
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(normalized)) {
    throw new Error(`Invalid HTTP header name: ${normalized}`);
  }
  return normalized;
}

function normalizeHttpRequestAuthRuleSecret(
  value: unknown,
  path: string,
): SecretInput {
  const parsed = parseSecretInput(value);
  if (parsed.kind === 'invalid') {
    throw new Error(`${path} ${parsed.reason}`);
  }
  if (parsed.kind === 'plain') {
    throw new Error(
      `${path} must use an env/store secret reference such as \`{ "source": "store", "id": "SECRET_NAME" }\` or \`\${ENV_VAR}\``,
    );
  }
  return cloneConfig(parsed.ref);
}

function normalizeHttpRequestAuthRules(
  value: unknown,
  fallback: RuntimeHttpRequestAuthRule[],
): RuntimeHttpRequestAuthRule[] {
  if (!Array.isArray(value)) {
    return cloneConfig(fallback);
  }

  const rules: RuntimeHttpRequestAuthRule[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isRecord(entry)) continue;
    const urlPrefix = normalizeString(entry.urlPrefix, '', {
      allowEmpty: false,
    });
    if (!urlPrefix) continue;
    rules.push({
      urlPrefix,
      header: normalizeHttpHeaderName(entry.header, 'Authorization'),
      prefix: normalizeString(entry.prefix, 'Bearer', { allowEmpty: true }),
      secret: normalizeHttpRequestAuthRuleSecret(
        entry.secret,
        `tools.httpRequest.authRules[${index}].secret`,
      ),
    });
  }
  return rules;
}

function normalizeContainerSandboxMode(
  value: unknown,
  fallback: ContainerSandboxMode,
): ContainerSandboxMode {
  const normalized = normalizeString(value, fallback, {
    allowEmpty: false,
  }).toLowerCase();
  return normalized === 'host' ? 'host' : 'container';
}

function normalizeSessionResetPolicyOverride(
  value: unknown,
  fallback: RuntimeConfig['sessionReset']['defaultPolicy'],
): NonNullable<RuntimeConfig['sessionReset']['byChannelKind']>[string] | null {
  if (!isRecord(value)) return null;
  return {
    mode:
      hasOwn(value, 'mode') && value.mode != null
        ? normalizeSessionResetMode(value.mode, fallback.mode)
        : undefined,
    atHour:
      hasOwn(value, 'atHour') && value.atHour != null
        ? normalizeInteger(value.atHour, fallback.atHour, {
            min: 0,
            max: 23,
          })
        : undefined,
    idleMinutes:
      hasOwn(value, 'idleMinutes') && value.idleMinutes != null
        ? normalizeInteger(value.idleMinutes, fallback.idleMinutes, {
            min: 1,
          })
        : undefined,
  };
}

function normalizeSessionResetByChannelKind(
  value: unknown,
  fallback: RuntimeConfig['sessionReset']['defaultPolicy'],
): Record<
  string,
  NonNullable<RuntimeConfig['sessionReset']['byChannelKind']>[string]
> {
  const rawByChannelKind = isRecord(value) ? value : {};
  return Object.fromEntries(
    Object.entries(rawByChannelKind).flatMap(([key, rawOverride]) => {
      const normalizedKey = normalizeString(key, '', { allowEmpty: false });
      if (!normalizedKey) return [];

      const normalizedOverride = normalizeSessionResetPolicyOverride(
        rawOverride,
        fallback,
      );
      if (!normalizedOverride) return [];

      return [[normalizedKey, normalizedOverride]];
    }),
  );
}

function normalizeAuxiliaryProviderSelection(
  value: unknown,
  fallback: RuntimeAuxiliaryProviderSelection,
): RuntimeAuxiliaryProviderSelection {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || isRuntimeProviderId(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeWebSearchProvider(
  value: unknown,
  fallback: RuntimeWebSearchProvider,
): RuntimeWebSearchProvider {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'auto' ||
    normalized === 'brave' ||
    normalized === 'perplexity' ||
    normalized === 'tavily' ||
    normalized === 'duckduckgo' ||
    normalized === 'searxng'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeWebSearchFallbackProviders(
  value: unknown,
  fallback: RuntimeWebSearchConcreteProvider[],
): RuntimeWebSearchConcreteProvider[] {
  const normalized = normalizeStringArray(value, fallback);
  const seen = new Set<RuntimeWebSearchConcreteProvider>();
  const providers: RuntimeWebSearchConcreteProvider[] = [];
  for (const entry of normalized) {
    const provider = normalizeWebSearchProvider(entry, 'auto');
    if (provider === 'auto' || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

function normalizeAudioTranscriptionProvider(
  value: unknown,
): RuntimeAudioTranscriptionProvider | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'groq') return 'groq';
  if (normalized === 'deepgram') return 'deepgram';
  if (normalized === 'google') return 'google';
  return null;
}

function normalizeAudioModelEntry(
  value: unknown,
): RuntimeAudioTranscriptionModelConfig | null {
  if (!isRecord(value)) return null;
  const rawType = normalizeString(value.type, '', {
    allowEmpty: true,
  }).toLowerCase();

  if (rawType === 'cli' || (!rawType && typeof value.command === 'string')) {
    const command = normalizeString(value.command, '', {
      allowEmpty: false,
    });
    if (!command) return null;
    const args = normalizeStringArray(value.args, []);
    const prompt = normalizeString(value.prompt, '', {
      allowEmpty: true,
    });
    const timeoutMs = normalizeInteger(value.timeoutMs, 0, { min: 0 });
    const maxBytes = normalizeInteger(value.maxBytes, 0, { min: 0 });
    return {
      type: 'cli',
      command,
      args,
      ...(prompt ? { prompt } : {}),
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
      ...(maxBytes > 0 ? { maxBytes } : {}),
    };
  }

  const provider = normalizeAudioTranscriptionProvider(value.provider);
  if (!provider) return null;
  const model = normalizeString(value.model, '', {
    allowEmpty: true,
  });
  const baseUrl = normalizeString(value.baseUrl, '', {
    allowEmpty: true,
  });
  const prompt = normalizeString(value.prompt, '', {
    allowEmpty: true,
  });
  const language = normalizeString(value.language, '', {
    allowEmpty: true,
  });
  const timeoutMs = normalizeInteger(value.timeoutMs, 0, { min: 0 });
  const maxBytes = normalizeInteger(value.maxBytes, 0, { min: 0 });
  const headers = normalizeStringRecord(value.headers);
  const query = normalizeStringRecord(value.query);
  return {
    type: 'provider',
    provider,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(prompt ? { prompt } : {}),
    ...(language ? { language } : {}),
    ...(timeoutMs > 0 ? { timeoutMs } : {}),
    ...(maxBytes > 0 ? { maxBytes } : {}),
  };
}

function normalizeAudioModelEntries(
  value: unknown,
  fallback: RuntimeAudioTranscriptionModelConfig[],
): RuntimeAudioTranscriptionModelConfig[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .map((entry) => normalizeAudioModelEntry(entry))
    .filter((entry): entry is RuntimeAudioTranscriptionModelConfig =>
      Boolean(entry),
    );
}

function normalizeMediaAudioConfig(
  value: unknown,
  fallback: RuntimeMediaAudioConfig,
): RuntimeMediaAudioConfig {
  if (!isRecord(value)) {
    return {
      ...fallback,
      models: [...fallback.models],
    };
  }
  return {
    enabled: normalizeBoolean(value.enabled, fallback.enabled),
    maxBytes: normalizeInteger(value.maxBytes, fallback.maxBytes, {
      min: 1_024,
      max: 25 * 1024 * 1024,
    }),
    maxFiles: normalizeInteger(value.maxFiles, fallback.maxFiles, {
      min: 1,
      max: 8,
    }),
    maxCharsPerTranscript: normalizeInteger(
      value.maxCharsPerTranscript,
      fallback.maxCharsPerTranscript,
      { min: 256, max: 32_000 },
    ),
    maxTotalChars: normalizeInteger(
      value.maxTotalChars,
      fallback.maxTotalChars,
      { min: 256, max: 64_000 },
    ),
    timeoutMs: normalizeInteger(value.timeoutMs, fallback.timeoutMs, {
      min: 1_000,
      max: 300_000,
    }),
    prompt: normalizeString(value.prompt, fallback.prompt, {
      allowEmpty: false,
    }),
    language: normalizeString(value.language, fallback.language, {
      allowEmpty: true,
    }),
    models: normalizeAudioModelEntries(value.models, fallback.models),
  };
}

function normalizeMediaConfig(
  value: unknown,
  fallback: RuntimeConfig['media'],
): RuntimeConfig['media'] {
  const raw = isRecord(value) ? value : {};
  return {
    audio: normalizeMediaAudioConfig(raw.audio, fallback.audio),
  };
}

function normalizeRoutingConciergeConfig(
  value: unknown,
  fallback: RuntimeRoutingConciergeConfig,
): RuntimeRoutingConciergeConfig {
  const raw = isRecord(value) ? value : {};
  const rawProfiles = isRecord(raw.profiles) ? raw.profiles : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    model: normalizeString(raw.model, fallback.model, {
      allowEmpty: false,
    }),
    profiles: {
      asap: normalizeString(rawProfiles.asap, fallback.profiles.asap, {
        allowEmpty: false,
      }),
      balanced: normalizeString(
        rawProfiles.balanced,
        fallback.profiles.balanced,
        {
          allowEmpty: false,
        },
      ),
      noHurry: normalizeString(
        rawProfiles.noHurry ?? rawProfiles.no_hurry,
        fallback.profiles.noHurry,
        {
          allowEmpty: false,
        },
      ),
    },
  };
}

function normalizeTavilySearchDepth(
  value: unknown,
  fallback: 'basic' | 'advanced',
): 'basic' | 'advanced' {
  if (typeof value !== 'string') return fallback;
  return value.trim().toLowerCase() === 'basic' ? 'basic' : 'advanced';
}

function parseConfigPatch(payload: unknown): DeepPartial<RuntimeConfig> {
  if (!isRecord(payload)) {
    throw new Error('config.json must contain a top-level object');
  }
  return payload as DeepPartial<RuntimeConfig>;
}

function normalizeRuntimeConfig(
  patch?: DeepPartial<RuntimeConfig>,
): RuntimeConfig {
  const normalizeAnthropicMethodValue = (
    value: unknown,
    fallback: AnthropicMethod,
  ): AnthropicMethod => {
    const normalized = String(value || '')
      .trim()
      .toLowerCase();
    if (
      normalized === 'claude-cli' ||
      normalized === 'claude_cli' ||
      normalized === 'claudecli'
    ) {
      return 'claude-cli';
    }
    if (
      normalized === 'api-key' ||
      normalized === 'apikey' ||
      normalized === 'api_key' ||
      normalized === 'token'
    ) {
      return 'api-key';
    }
    return fallback;
  };

  const raw = patch ?? {};

  const rawSecurity = isRecord(raw.security) ? raw.security : {};
  const rawDeployment = isRecord(raw.deployment) ? raw.deployment : {};
  const rawAgents = isRecord(raw.agents) ? raw.agents : {};
  const rawSkills = isRecord(raw.skills) ? raw.skills : {};
  const rawPlugins = isRecord(raw.plugins) ? raw.plugins : {};
  const rawAdaptiveSkills = isRecord(raw.adaptiveSkills)
    ? raw.adaptiveSkills
    : {};
  const rawTrajectoryCapture = isRecord(rawAdaptiveSkills.trajectoryCapture)
    ? rawAdaptiveSkills.trajectoryCapture
    : {};
  const rawChannelInstructions = isRecord(raw.channelInstructions)
    ? raw.channelInstructions
    : {};
  const rawDiscord = isRecord(raw.discord) ? raw.discord : {};
  const rawMSTeams = isRecord(raw.msteams) ? raw.msteams : {};
  const rawSignal = isRecord(raw.signal) ? raw.signal : {};
  const rawSlack = isRecord(raw.slack) ? raw.slack : {};
  const rawTelegram = isRecord(raw.telegram) ? raw.telegram : {};
  const rawWhatsApp = isRecord(raw.whatsapp) ? raw.whatsapp : {};
  const rawVoice = isRecord(raw.voice) ? raw.voice : {};
  const rawIMessage = isRecord(raw.imessage) ? raw.imessage : {};
  const rawEmail = isRecord(raw.email) ? raw.email : {};
  const rawHybridAi = isRecord(raw.hybridai) ? raw.hybridai : {};
  const rawCodex = isRecord(raw.codex) ? raw.codex : {};
  const rawAnthropic = isRecord(raw.anthropic) ? raw.anthropic : {};
  const rawOpenRouter = isRecord(raw.openrouter) ? raw.openrouter : {};
  const rawMistral = isRecord(raw.mistral) ? raw.mistral : {};
  const rawHuggingFace = isRecord(raw.huggingface) ? raw.huggingface : {};
  const rawGemini = isRecord(raw.gemini) ? raw.gemini : {};
  const rawDeepSeek = isRecord(raw.deepseek) ? raw.deepseek : {};
  const rawXai = isRecord(raw.xai) ? raw.xai : {};
  const rawZai = isRecord(raw.zai) ? raw.zai : {};
  const rawKimi = isRecord(raw.kimi) ? raw.kimi : {};
  const rawMiniMax = isRecord(raw.minimax) ? raw.minimax : {};
  const rawDashScope = isRecord(raw.dashscope) ? raw.dashscope : {};
  const rawXiaomi = isRecord(raw.xiaomi) ? raw.xiaomi : {};
  const rawKilo = isRecord(raw.kilo) ? raw.kilo : {};
  const rawLocal = isRecord(raw.local) ? raw.local : {};
  const rawAuxiliaryModels = isRecord(raw.auxiliaryModels)
    ? raw.auxiliaryModels
    : {};
  const rawVisionAuxiliaryModel = isRecord(rawAuxiliaryModels.vision)
    ? rawAuxiliaryModels.vision
    : {};
  const rawCompressionAuxiliaryModel = isRecord(rawAuxiliaryModels.compression)
    ? rawAuxiliaryModels.compression
    : {};
  const rawWebExtractAuxiliaryModel = isRecord(rawAuxiliaryModels.web_extract)
    ? rawAuxiliaryModels.web_extract
    : {};
  const rawSessionSearchAuxiliaryModel = isRecord(
    rawAuxiliaryModels.session_search,
  )
    ? rawAuxiliaryModels.session_search
    : {};
  const rawSkillsHubAuxiliaryModel = isRecord(rawAuxiliaryModels.skills_hub)
    ? rawAuxiliaryModels.skills_hub
    : {};
  const rawEvalJudgeAuxiliaryModel = isRecord(rawAuxiliaryModels.eval_judge)
    ? rawAuxiliaryModels.eval_judge
    : {};
  const rawMcpAuxiliaryModel = isRecord(rawAuxiliaryModels.mcp)
    ? rawAuxiliaryModels.mcp
    : {};
  const rawFlushMemoriesAuxiliaryModel = isRecord(
    rawAuxiliaryModels.flush_memories,
  )
    ? rawAuxiliaryModels.flush_memories
    : {};
  const rawLocalBackends = isRecord(rawLocal.backends) ? rawLocal.backends : {};
  const rawOllamaBackend = isRecord(rawLocalBackends.ollama)
    ? rawLocalBackends.ollama
    : {};
  const rawLmStudioBackend = isRecord(rawLocalBackends.lmstudio)
    ? rawLocalBackends.lmstudio
    : {};
  const rawLlamacppBackend = isRecord(rawLocalBackends.llamacpp)
    ? rawLocalBackends.llamacpp
    : {};
  const rawVllmBackend = isRecord(rawLocalBackends.vllm)
    ? rawLocalBackends.vllm
    : {};
  const rawLocalDiscovery = isRecord(rawLocal.discovery)
    ? rawLocal.discovery
    : {};
  const rawLocalHealthCheck = isRecord(rawLocal.healthCheck)
    ? rawLocal.healthCheck
    : {};
  const rawContainer = isRecord(raw.container) ? raw.container : {};
  const rawMcpServers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
  const rawWeb = isRecord(raw.web) ? raw.web : {};
  const rawWebSearch = isRecord(rawWeb.search) ? rawWeb.search : {};
  const rawMedia = isRecord(raw.media) ? raw.media : {};
  const rawRouting = isRecord(raw.routing) ? raw.routing : {};
  const rawHeartbeat = isRecord(raw.heartbeat) ? raw.heartbeat : {};
  const rawMemory = isRecord(raw.memory) ? raw.memory : {};
  const rawOps = isRecord(raw.ops) ? raw.ops : {};
  const rawObservability = isRecord(raw.observability) ? raw.observability : {};
  const rawSessionCompaction = isRecord(raw.sessionCompaction)
    ? raw.sessionCompaction
    : {};
  const rawPreFlush = isRecord(rawSessionCompaction.preCompactionMemoryFlush)
    ? rawSessionCompaction.preCompactionMemoryFlush
    : {};
  const rawInLoopGuard = isRecord(rawSessionCompaction.inLoopGuard)
    ? rawSessionCompaction.inLoopGuard
    : {};
  const rawSessionReset = isRecord(raw.sessionReset) ? raw.sessionReset : {};
  const rawDefaultResetPolicy = isRecord(rawSessionReset.defaultPolicy)
    ? rawSessionReset.defaultPolicy
    : {};
  const rawResetByChannelKind = isRecord(rawSessionReset.byChannelKind)
    ? rawSessionReset.byChannelKind
    : {};
  const rawSessionRouting = isRecord(raw.sessionRouting)
    ? raw.sessionRouting
    : {};
  const rawPromptHooks = isRecord(raw.promptHooks) ? raw.promptHooks : {};
  const rawProactive = isRecord(raw.proactive) ? raw.proactive : {};
  const rawActiveHours = isRecord(rawProactive.activeHours)
    ? rawProactive.activeHours
    : {};
  const rawDelegation = isRecord(rawProactive.delegation)
    ? rawProactive.delegation
    : {};
  const rawAutoRetry = isRecord(rawProactive.autoRetry)
    ? rawProactive.autoRetry
    : {};
  const rawRalph = isRecord(rawProactive.ralph) ? rawProactive.ralph : {};
  const rawScheduler = isRecord(raw.scheduler) ? raw.scheduler : {};

  const defaultOps = DEFAULT_RUNTIME_CONFIG.ops;
  const emailEnabled = normalizeBoolean(
    rawEmail.enabled,
    DEFAULT_RUNTIME_CONFIG.email.enabled,
  );
  const voiceEnabled = normalizeBoolean(
    rawVoice.enabled,
    DEFAULT_RUNTIME_CONFIG.voice.enabled,
  );
  const imessageEnabled = normalizeBoolean(
    rawIMessage.enabled,
    DEFAULT_RUNTIME_CONFIG.imessage.enabled,
  );
  const imessageBackend = normalizeIMessageBackend(
    rawIMessage.backend,
    DEFAULT_RUNTIME_CONFIG.imessage.backend,
  );
  const vllmEnabled = normalizeBoolean(
    rawVllmBackend.enabled,
    DEFAULT_RUNTIME_CONFIG.local.backends.vllm.enabled,
  );
  const resolvedWebApiToken = resolveConfiguredSecretInput(rawOps.webApiToken, {
    path: 'ops.webApiToken',
    required: isSecretRefInput(rawOps.webApiToken),
  });
  const resolvedGatewayApiToken = resolveConfiguredSecretInput(
    rawOps.gatewayApiToken,
    {
      path: 'ops.gatewayApiToken',
      required: isSecretRefInput(rawOps.gatewayApiToken),
    },
  );
  const resolvedIMessagePassword = resolveConfiguredSecretInput(
    rawIMessage.password,
    {
      path: 'imessage.password',
      required:
        isSecretRefInput(rawIMessage.password) &&
        imessageEnabled &&
        imessageBackend === 'bluebubbles',
    },
  );
  const resolvedEmailPassword = resolveConfiguredSecretInput(
    rawEmail.password,
    {
      path: 'email.password',
      required: isSecretRefInput(rawEmail.password) && emailEnabled,
    },
  );
  const rawVoiceTwilio = isRecord(rawVoice.twilio) ? rawVoice.twilio : {};
  const resolvedVoiceAuthToken = resolveConfiguredSecretInput(
    rawVoiceTwilio.authToken,
    {
      path: 'voice.twilio.authToken',
      required: isSecretRefInput(rawVoiceTwilio.authToken) && voiceEnabled,
    },
  );
  const resolvedVllmApiKey = resolveConfiguredSecretInput(
    rawVllmBackend.apiKey,
    {
      path: 'local.backends.vllm.apiKey',
      required: isSecretRefInput(rawVllmBackend.apiKey) && vllmEnabled,
    },
  );
  const resolvedTelegramBotToken = resolveConfiguredSecretInput(
    rawTelegram.botToken,
    {
      path: 'telegram.botToken',
      required:
        isSecretRefInput(rawTelegram.botToken) && Boolean(rawTelegram.enabled),
    },
  );
  const healthPort = normalizeInteger(
    rawOps.healthPort,
    defaultOps.healthPort,
    { min: 1, max: 65_535 },
  );
  const webApiToken = normalizeString(
    resolvedWebApiToken,
    defaultOps.webApiToken,
    { allowEmpty: true },
  );
  const hybridBaseUrl = normalizeBaseUrl(
    rawHybridAi.baseUrl,
    DEFAULT_RUNTIME_CONFIG.hybridai.baseUrl,
  );
  const hybridDefaultChatbotId = normalizeString(
    rawHybridAi.defaultChatbotId,
    DEFAULT_RUNTIME_CONFIG.hybridai.defaultChatbotId,
    { allowEmpty: true },
  );
  const normalizedDbPath = normalizeDbPath(rawOps.dbPath, defaultOps.dbPath);

  const threshold = normalizeInteger(
    rawSessionCompaction.threshold,
    DEFAULT_RUNTIME_CONFIG.sessionCompaction.threshold,
    { min: 20 },
  );
  const tokenBudget = normalizeInteger(
    rawSessionCompaction.tokenBudget,
    DEFAULT_RUNTIME_CONFIG.sessionCompaction.tokenBudget,
    { min: 1_000 },
  );
  const budgetRatio = normalizeNumber(
    rawSessionCompaction.budgetRatio,
    DEFAULT_RUNTIME_CONFIG.sessionCompaction.budgetRatio,
    { min: 0.05, max: 1 },
  );
  const keepRecentRaw = normalizeInteger(
    rawSessionCompaction.keepRecent,
    DEFAULT_RUNTIME_CONFIG.sessionCompaction.keepRecent,
    { min: 1 },
  );
  const keepRecent = Math.min(keepRecentRaw, Math.max(1, threshold - 1));

  const modelList = normalizeStringArray(
    rawHybridAi.models,
    DEFAULT_RUNTIME_CONFIG.hybridai.models,
  );
  const codexModelList = normalizeCodexModelArray(
    rawCodex.models,
    DEFAULT_RUNTIME_CONFIG.codex.models,
  );
  const anthropicModelList = normalizeStringArray(
    rawAnthropic.models,
    DEFAULT_RUNTIME_CONFIG.anthropic.models,
  );
  const openRouterModelList = normalizeStringArray(
    rawOpenRouter.models,
    DEFAULT_RUNTIME_CONFIG.openrouter.models,
  );
  const mistralModelList = normalizeStringArray(
    rawMistral.models,
    DEFAULT_RUNTIME_CONFIG.mistral.models,
  );
  const huggingFaceModelList = normalizeStringArray(
    rawHuggingFace.models,
    DEFAULT_RUNTIME_CONFIG.huggingface.models,
  );
  const geminiModelList = normalizeStringArray(
    rawGemini.models,
    DEFAULT_RUNTIME_CONFIG.gemini.models,
  );
  const deepSeekModelList = normalizeStringArray(
    rawDeepSeek.models,
    DEFAULT_RUNTIME_CONFIG.deepseek.models,
  );
  const xaiModelList = normalizeStringArray(
    rawXai.models,
    DEFAULT_RUNTIME_CONFIG.xai.models,
  );
  const zaiModelList = normalizeStringArray(
    rawZai.models,
    DEFAULT_RUNTIME_CONFIG.zai.models,
  );
  const kimiModelList = normalizeStringArray(
    rawKimi.models,
    DEFAULT_RUNTIME_CONFIG.kimi.models,
  );
  const miniMaxModelList = normalizeStringArray(
    rawMiniMax.models,
    DEFAULT_RUNTIME_CONFIG.minimax.models,
  );
  const dashScopeModelList = normalizeStringArray(
    rawDashScope.models,
    DEFAULT_RUNTIME_CONFIG.dashscope.models,
  );
  const xiaomiModelList = normalizeStringArray(
    rawXiaomi.models,
    DEFAULT_RUNTIME_CONFIG.xiaomi.models,
  );
  const kiloModelList = normalizeStringArray(
    rawKilo.models,
    DEFAULT_RUNTIME_CONFIG.kilo.models,
  );
  const normalizedCommandUserId = normalizeString(
    rawDiscord.commandUserId,
    DEFAULT_RUNTIME_CONFIG.discord.commandUserId,
    { allowEmpty: true },
  );
  const normalizedCommandAllowedUserIds = normalizeStringArray(
    rawDiscord.commandAllowedUserIds,
    DEFAULT_RUNTIME_CONFIG.discord.commandAllowedUserIds,
  );
  const legacyCommandModeFallback = normalizedCommandUserId
    ? 'restricted'
    : DEFAULT_RUNTIME_CONFIG.discord.commandMode;
  const normalizedCommandMode = normalizeDiscordCommandMode(
    rawDiscord.commandMode,
    legacyCommandModeFallback,
  );
  const normalizedTrajectoryRetentionDays = normalizeInteger(
    rawTrajectoryCapture.retentionDays,
    DEFAULT_RUNTIME_CONFIG.adaptiveSkills.trajectoryCapture.retentionDays,
    { min: 0 },
  );

  return {
    version: CONFIG_VERSION,
    security: {
      trustModelAccepted: normalizeBoolean(
        rawSecurity.trustModelAccepted,
        DEFAULT_RUNTIME_CONFIG.security.trustModelAccepted,
      ),
      trustModelAcceptedAt: normalizeString(
        rawSecurity.trustModelAcceptedAt,
        DEFAULT_RUNTIME_CONFIG.security.trustModelAcceptedAt,
        { allowEmpty: true },
      ),
      trustModelVersion: normalizeString(
        rawSecurity.trustModelVersion,
        DEFAULT_RUNTIME_CONFIG.security.trustModelVersion,
        { allowEmpty: true },
      ),
      trustModelAcceptedBy: normalizeString(
        rawSecurity.trustModelAcceptedBy,
        DEFAULT_RUNTIME_CONFIG.security.trustModelAcceptedBy,
        { allowEmpty: true },
      ),
    },
    deployment: normalizeDeploymentConfig(
      rawDeployment,
      DEFAULT_RUNTIME_CONFIG.deployment,
    ),
    agents: normalizeAgentsConfig(rawAgents, DEFAULT_RUNTIME_CONFIG.agents),
    skills: {
      extraDirs: normalizeStringArray(
        rawSkills.extraDirs,
        DEFAULT_RUNTIME_CONFIG.skills.extraDirs,
      ),
      disabled: normalizeStringArray(
        rawSkills.disabled,
        DEFAULT_RUNTIME_CONFIG.skills.disabled,
      ),
      channelDisabled: normalizeSkillChannelDisabled(rawSkills.channelDisabled),
      autonomy: normalizeSkillAutonomyConfig(
        rawSkills.autonomy,
        DEFAULT_RUNTIME_CONFIG.skills.autonomy,
      ),
      installed: normalizeRuntimeInstalledSkillManifests(rawSkills.installed),
    },
    tools: {
      disabled: normalizeStringArray(
        raw.tools && isRecord(raw.tools) ? raw.tools.disabled : undefined,
        DEFAULT_RUNTIME_CONFIG.tools.disabled,
      ),
      httpRequest: {
        authRules: normalizeHttpRequestAuthRules(
          raw.tools && isRecord(raw.tools) && isRecord(raw.tools.httpRequest)
            ? raw.tools.httpRequest.authRules
            : undefined,
          DEFAULT_RUNTIME_CONFIG.tools.httpRequest.authRules,
        ),
      },
    },
    channelInstructions: normalizeChannelInstructionsConfig(
      rawChannelInstructions,
      DEFAULT_RUNTIME_CONFIG.channelInstructions,
    ),
    plugins: normalizeRuntimePluginsConfig(
      rawPlugins,
      DEFAULT_RUNTIME_CONFIG.plugins,
    ),
    adaptiveSkills: {
      enabled: normalizeBoolean(
        rawAdaptiveSkills.enabled,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.enabled,
      ),
      observationEnabled: normalizeBoolean(
        rawAdaptiveSkills.observationEnabled,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.observationEnabled,
      ),
      trajectoryCapture: {
        enabledAgentIds: normalizeStringArray(
          rawTrajectoryCapture.enabledAgentIds,
          DEFAULT_RUNTIME_CONFIG.adaptiveSkills.trajectoryCapture
            .enabledAgentIds,
        ),
        storeDir: normalizeString(
          rawTrajectoryCapture.storeDir,
          DEFAULT_RUNTIME_CONFIG.adaptiveSkills.trajectoryCapture.storeDir,
          { allowEmpty: true },
        ),
        retentionDays: normalizedTrajectoryRetentionDays,
        retentionDaysByTenant: normalizeRetentionDaysByTenant(
          rawTrajectoryCapture.retentionDaysByTenant,
          DEFAULT_RUNTIME_CONFIG.adaptiveSkills.trajectoryCapture
            .retentionDaysByTenant,
          normalizedTrajectoryRetentionDays,
        ),
      },
      inspectionIntervalMs: normalizeInteger(
        rawAdaptiveSkills.inspectionIntervalMs,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.inspectionIntervalMs,
        { min: 60_000 },
      ),
      observationRetentionDays: normalizeInteger(
        rawAdaptiveSkills.observationRetentionDays,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.observationRetentionDays,
        { min: 0 },
      ),
      trailingWindowHours: normalizeInteger(
        rawAdaptiveSkills.trailingWindowHours,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.trailingWindowHours,
        { min: 1 },
      ),
      minExecutionsForInspection: normalizeInteger(
        rawAdaptiveSkills.minExecutionsForInspection,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.minExecutionsForInspection,
        { min: 1 },
      ),
      degradationSuccessRateThreshold: normalizeNumber(
        rawAdaptiveSkills.degradationSuccessRateThreshold,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.degradationSuccessRateThreshold,
        { min: 0, max: 1 },
      ),
      degradationToolBreakageThreshold: normalizeNumber(
        rawAdaptiveSkills.degradationToolBreakageThreshold,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.degradationToolBreakageThreshold,
        { min: 0, max: 1 },
      ),
      autoApplyEnabled: normalizeBoolean(
        rawAdaptiveSkills.autoApplyEnabled,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.autoApplyEnabled,
      ),
      evaluationRunsBeforeRollback: normalizeInteger(
        rawAdaptiveSkills.evaluationRunsBeforeRollback,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.evaluationRunsBeforeRollback,
        { min: 1 },
      ),
      rollbackImprovementThreshold: normalizeNumber(
        rawAdaptiveSkills.rollbackImprovementThreshold,
        DEFAULT_RUNTIME_CONFIG.adaptiveSkills.rollbackImprovementThreshold,
        { min: 0, max: 1 },
      ),
    },
    discord: {
      prefix: normalizeString(
        rawDiscord.prefix,
        DEFAULT_RUNTIME_CONFIG.discord.prefix,
        { allowEmpty: false },
      ),
      guildMembersIntent: normalizeBoolean(
        rawDiscord.guildMembersIntent,
        DEFAULT_RUNTIME_CONFIG.discord.guildMembersIntent,
      ),
      presenceIntent: normalizeBoolean(
        rawDiscord.presenceIntent,
        DEFAULT_RUNTIME_CONFIG.discord.presenceIntent,
      ),
      commandsOnly: normalizeBoolean(
        rawDiscord.commandsOnly,
        DEFAULT_RUNTIME_CONFIG.discord.commandsOnly,
      ),
      commandMode: normalizedCommandMode,
      commandAllowedUserIds: normalizedCommandAllowedUserIds,
      commandUserId: normalizedCommandUserId,
      groupPolicy: normalizeDiscordGroupPolicy(
        rawDiscord.groupPolicy,
        DEFAULT_RUNTIME_CONFIG.discord.groupPolicy,
      ),
      sendPolicy: normalizeDiscordSendPolicy(
        rawDiscord.sendPolicy,
        DEFAULT_RUNTIME_CONFIG.discord.sendPolicy,
      ),
      sendAllowedChannelIds: normalizeStringArray(
        rawDiscord.sendAllowedChannelIds,
        DEFAULT_RUNTIME_CONFIG.discord.sendAllowedChannelIds,
      ),
      freeResponseChannels: normalizeStringArray(
        rawDiscord.freeResponseChannels,
        DEFAULT_RUNTIME_CONFIG.discord.freeResponseChannels,
      ),
      textChunkLimit: normalizeInteger(
        rawDiscord.textChunkLimit,
        DEFAULT_RUNTIME_CONFIG.discord.textChunkLimit,
        { min: 200, max: 2_000 },
      ),
      maxLinesPerMessage: normalizeInteger(
        rawDiscord.maxLinesPerMessage,
        DEFAULT_RUNTIME_CONFIG.discord.maxLinesPerMessage,
        { min: 4, max: 200 },
      ),
      humanDelay: normalizeDiscordHumanDelayConfig(
        rawDiscord.humanDelay,
        DEFAULT_RUNTIME_CONFIG.discord.humanDelay,
      ),
      typingMode: normalizeDiscordTypingMode(
        rawDiscord.typingMode,
        DEFAULT_RUNTIME_CONFIG.discord.typingMode,
      ),
      presence: normalizeDiscordPresenceConfig(
        rawDiscord.presence,
        DEFAULT_RUNTIME_CONFIG.discord.presence,
      ),
      lifecycleReactions: normalizeDiscordLifecycleReactionsConfig(
        rawDiscord.lifecycleReactions,
        DEFAULT_RUNTIME_CONFIG.discord.lifecycleReactions,
      ),
      ackReaction: normalizeString(
        rawDiscord.ackReaction,
        DEFAULT_RUNTIME_CONFIG.discord.ackReaction,
        { allowEmpty: false },
      ),
      ackReactionScope: normalizeDiscordAckReactionScope(
        rawDiscord.ackReactionScope,
        DEFAULT_RUNTIME_CONFIG.discord.ackReactionScope,
      ),
      removeAckAfterReply: normalizeBoolean(
        rawDiscord.removeAckAfterReply,
        DEFAULT_RUNTIME_CONFIG.discord.removeAckAfterReply,
      ),
      debounceMs: normalizeInteger(
        rawDiscord.debounceMs,
        DEFAULT_RUNTIME_CONFIG.discord.debounceMs,
        { min: 0, max: 120_000 },
      ),
      rateLimitPerUser: normalizeInteger(
        rawDiscord.rateLimitPerUser,
        DEFAULT_RUNTIME_CONFIG.discord.rateLimitPerUser,
        { min: 0, max: 300 },
      ),
      rateLimitExemptRoles: normalizeStringArray(
        rawDiscord.rateLimitExemptRoles,
        DEFAULT_RUNTIME_CONFIG.discord.rateLimitExemptRoles,
      ),
      suppressPatterns: normalizeStringArray(
        rawDiscord.suppressPatterns,
        DEFAULT_RUNTIME_CONFIG.discord.suppressPatterns,
      ),
      maxConcurrentPerChannel: normalizeInteger(
        rawDiscord.maxConcurrentPerChannel,
        DEFAULT_RUNTIME_CONFIG.discord.maxConcurrentPerChannel,
        { min: 1, max: 16 },
      ),
      guilds: normalizeDiscordGuildMap(
        rawDiscord.guilds,
        DEFAULT_RUNTIME_CONFIG.discord.guilds,
      ),
    },
    msteams: normalizeMSTeamsConfig(rawMSTeams, DEFAULT_RUNTIME_CONFIG.msteams),
    signal: normalizeSignalConfig(rawSignal, DEFAULT_RUNTIME_CONFIG.signal),
    slack: normalizeSlackConfig(rawSlack, DEFAULT_RUNTIME_CONFIG.slack),
    telegram: normalizeTelegramConfig(
      rawTelegram,
      DEFAULT_RUNTIME_CONFIG.telegram,
      {
        botToken: resolvedTelegramBotToken,
      },
    ),
    whatsapp: normalizeWhatsAppConfig(
      rawWhatsApp,
      DEFAULT_RUNTIME_CONFIG.whatsapp,
    ),
    voice: normalizeVoiceConfig(rawVoice, DEFAULT_RUNTIME_CONFIG.voice, {
      authToken: resolvedVoiceAuthToken,
    }),
    imessage: normalizeIMessageConfig(
      rawIMessage,
      DEFAULT_RUNTIME_CONFIG.imessage,
      {
        password: resolvedIMessagePassword,
      },
    ),
    email: normalizeEmailConfig(rawEmail, DEFAULT_RUNTIME_CONFIG.email, {
      password: resolvedEmailPassword,
    }),
    hybridai: {
      baseUrl: hybridBaseUrl,
      defaultModel: normalizeString(
        rawHybridAi.defaultModel,
        DEFAULT_RUNTIME_CONFIG.hybridai.defaultModel,
        { allowEmpty: false },
      ),
      defaultChatbotId: hybridDefaultChatbotId,
      maxTokens: normalizeInteger(
        rawHybridAi.maxTokens,
        DEFAULT_RUNTIME_CONFIG.hybridai.maxTokens,
        { min: 256, max: 32_768 },
      ),
      enableRag: normalizeBoolean(
        rawHybridAi.enableRag,
        DEFAULT_RUNTIME_CONFIG.hybridai.enableRag,
      ),
      models: modelList,
    },
    codex: {
      baseUrl: normalizeBaseUrl(
        rawCodex.baseUrl,
        DEFAULT_RUNTIME_CONFIG.codex.baseUrl,
      ),
      models: codexModelList,
    },
    anthropic: {
      enabled: normalizeBoolean(
        rawAnthropic.enabled,
        DEFAULT_RUNTIME_CONFIG.anthropic.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawAnthropic.baseUrl,
        DEFAULT_RUNTIME_CONFIG.anthropic.baseUrl,
      ),
      method: normalizeAnthropicMethodValue(
        rawAnthropic.method,
        DEFAULT_RUNTIME_CONFIG.anthropic.method,
      ),
      models: anthropicModelList,
    },
    openrouter: {
      enabled: normalizeBoolean(
        rawOpenRouter.enabled,
        DEFAULT_RUNTIME_CONFIG.openrouter.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawOpenRouter.baseUrl,
        DEFAULT_RUNTIME_CONFIG.openrouter.baseUrl,
      ),
      models: openRouterModelList,
    },
    mistral: {
      enabled: normalizeBoolean(
        rawMistral.enabled,
        DEFAULT_RUNTIME_CONFIG.mistral.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawMistral.baseUrl,
        DEFAULT_RUNTIME_CONFIG.mistral.baseUrl,
      ),
      models: mistralModelList,
    },
    huggingface: {
      enabled: normalizeBoolean(
        rawHuggingFace.enabled,
        DEFAULT_RUNTIME_CONFIG.huggingface.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawHuggingFace.baseUrl,
        DEFAULT_RUNTIME_CONFIG.huggingface.baseUrl,
      ),
      models: huggingFaceModelList,
    },
    gemini: {
      enabled: normalizeBoolean(
        rawGemini.enabled,
        DEFAULT_RUNTIME_CONFIG.gemini.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawGemini.baseUrl,
        DEFAULT_RUNTIME_CONFIG.gemini.baseUrl,
      ),
      models: geminiModelList,
    },
    deepseek: {
      enabled: normalizeBoolean(
        rawDeepSeek.enabled,
        DEFAULT_RUNTIME_CONFIG.deepseek.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawDeepSeek.baseUrl,
        DEFAULT_RUNTIME_CONFIG.deepseek.baseUrl,
      ),
      models: deepSeekModelList,
    },
    xai: {
      enabled: normalizeBoolean(
        rawXai.enabled,
        DEFAULT_RUNTIME_CONFIG.xai.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawXai.baseUrl,
        DEFAULT_RUNTIME_CONFIG.xai.baseUrl,
      ),
      models: xaiModelList,
    },
    zai: {
      enabled: normalizeBoolean(
        rawZai.enabled,
        DEFAULT_RUNTIME_CONFIG.zai.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawZai.baseUrl,
        DEFAULT_RUNTIME_CONFIG.zai.baseUrl,
      ),
      models: zaiModelList,
    },
    kimi: {
      enabled: normalizeBoolean(
        rawKimi.enabled,
        DEFAULT_RUNTIME_CONFIG.kimi.enabled,
      ),
      baseUrl: migrateKimiBaseUrl(
        normalizeBaseUrl(rawKimi.baseUrl, DEFAULT_RUNTIME_CONFIG.kimi.baseUrl),
      ),
      models: kimiModelList,
    },
    minimax: {
      enabled: normalizeBoolean(
        rawMiniMax.enabled,
        DEFAULT_RUNTIME_CONFIG.minimax.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawMiniMax.baseUrl,
        DEFAULT_RUNTIME_CONFIG.minimax.baseUrl,
      ),
      models: miniMaxModelList,
    },
    dashscope: {
      enabled: normalizeBoolean(
        rawDashScope.enabled,
        DEFAULT_RUNTIME_CONFIG.dashscope.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawDashScope.baseUrl,
        DEFAULT_RUNTIME_CONFIG.dashscope.baseUrl,
      ),
      models: dashScopeModelList,
    },
    xiaomi: {
      enabled: normalizeBoolean(
        rawXiaomi.enabled,
        DEFAULT_RUNTIME_CONFIG.xiaomi.enabled,
      ),
      baseUrl: normalizeBaseUrl(
        rawXiaomi.baseUrl,
        DEFAULT_RUNTIME_CONFIG.xiaomi.baseUrl,
      ),
      models: xiaomiModelList,
    },
    kilo: {
      enabled: normalizeBoolean(
        rawKilo.enabled,
        DEFAULT_RUNTIME_CONFIG.kilo.enabled,
      ),
      baseUrl: migrateKiloBaseUrl(
        normalizeBaseUrl(rawKilo.baseUrl, DEFAULT_RUNTIME_CONFIG.kilo.baseUrl),
      ),
      models: kiloModelList,
    },
    local: {
      backends: {
        ollama: {
          enabled: normalizeBoolean(
            rawOllamaBackend.enabled,
            DEFAULT_RUNTIME_CONFIG.local.backends.ollama.enabled,
          ),
          baseUrl: normalizeBaseUrl(
            rawOllamaBackend.baseUrl,
            DEFAULT_RUNTIME_CONFIG.local.backends.ollama.baseUrl,
          ),
        },
        lmstudio: {
          enabled: normalizeBoolean(
            rawLmStudioBackend.enabled,
            DEFAULT_RUNTIME_CONFIG.local.backends.lmstudio.enabled,
          ),
          baseUrl: normalizeBaseUrl(
            rawLmStudioBackend.baseUrl,
            DEFAULT_RUNTIME_CONFIG.local.backends.lmstudio.baseUrl,
          ),
        },
        llamacpp: {
          enabled: normalizeBoolean(
            rawLlamacppBackend.enabled,
            DEFAULT_RUNTIME_CONFIG.local.backends.llamacpp.enabled,
          ),
          baseUrl: normalizeBaseUrl(
            rawLlamacppBackend.baseUrl,
            DEFAULT_RUNTIME_CONFIG.local.backends.llamacpp.baseUrl,
          ),
        },
        vllm: {
          enabled: vllmEnabled,
          baseUrl: normalizeBaseUrl(
            rawVllmBackend.baseUrl,
            DEFAULT_RUNTIME_CONFIG.local.backends.vllm.baseUrl,
          ),
          apiKey: normalizeString(
            resolvedVllmApiKey,
            DEFAULT_RUNTIME_CONFIG.local.backends.vllm.apiKey || '',
            { allowEmpty: true },
          ),
        },
      },
      discovery: {
        enabled: normalizeBoolean(
          rawLocalDiscovery.enabled,
          DEFAULT_RUNTIME_CONFIG.local.discovery.enabled,
        ),
        intervalMs: normalizeInteger(
          rawLocalDiscovery.intervalMs,
          DEFAULT_RUNTIME_CONFIG.local.discovery.intervalMs,
          { min: 10_000, max: 86_400_000 },
        ),
        maxModels: normalizeInteger(
          rawLocalDiscovery.maxModels,
          DEFAULT_RUNTIME_CONFIG.local.discovery.maxModels,
          { min: 1, max: 1_000 },
        ),
        concurrency: normalizeInteger(
          rawLocalDiscovery.concurrency,
          DEFAULT_RUNTIME_CONFIG.local.discovery.concurrency,
          { min: 1, max: 32 },
        ),
      },
      healthCheck: {
        enabled: normalizeBoolean(
          rawLocalHealthCheck.enabled,
          DEFAULT_RUNTIME_CONFIG.local.healthCheck.enabled,
        ),
        intervalMs: normalizeInteger(
          rawLocalHealthCheck.intervalMs,
          DEFAULT_RUNTIME_CONFIG.local.healthCheck.intervalMs,
          { min: 5_000, max: 86_400_000 },
        ),
        timeoutMs: normalizeInteger(
          rawLocalHealthCheck.timeoutMs,
          DEFAULT_RUNTIME_CONFIG.local.healthCheck.timeoutMs,
          { min: 250, max: 120_000 },
        ),
      },
      defaultContextWindow: normalizeInteger(
        rawLocal.defaultContextWindow,
        DEFAULT_RUNTIME_CONFIG.local.defaultContextWindow,
        { min: 1_024, max: 10_000_000 },
      ),
      defaultMaxTokens: normalizeInteger(
        rawLocal.defaultMaxTokens,
        DEFAULT_RUNTIME_CONFIG.local.defaultMaxTokens,
        { min: 64, max: 1_000_000 },
      ),
    },
    auxiliaryModels: {
      vision: {
        provider: normalizeAuxiliaryProviderSelection(
          rawVisionAuxiliaryModel.provider,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.vision.provider,
        ),
        model: normalizeString(
          rawVisionAuxiliaryModel.model,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.vision.model,
          { allowEmpty: true },
        ),
        maxTokens: normalizeInteger(
          rawVisionAuxiliaryModel.maxTokens,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.vision.maxTokens,
          { min: 0, max: 1_000_000 },
        ),
      },
      compression: {
        provider: normalizeAuxiliaryProviderSelection(
          rawCompressionAuxiliaryModel.provider,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.compression.provider,
        ),
        model: normalizeString(
          rawCompressionAuxiliaryModel.model,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.compression.model,
          { allowEmpty: true },
        ),
        maxTokens: normalizeInteger(
          rawCompressionAuxiliaryModel.maxTokens,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.compression.maxTokens,
          { min: 0, max: 1_000_000 },
        ),
      },
      web_extract: {
        provider: normalizeAuxiliaryProviderSelection(
          rawWebExtractAuxiliaryModel.provider,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.web_extract.provider,
        ),
        model: normalizeString(
          rawWebExtractAuxiliaryModel.model,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.web_extract.model,
          { allowEmpty: true },
        ),
        maxTokens: normalizeInteger(
          rawWebExtractAuxiliaryModel.maxTokens,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.web_extract.maxTokens,
          { min: 0, max: 1_000_000 },
        ),
      },
      session_search: {
        provider: normalizeAuxiliaryProviderSelection(
          rawSessionSearchAuxiliaryModel.provider,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.session_search.provider,
        ),
        model: normalizeString(
          rawSessionSearchAuxiliaryModel.model,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.session_search.model,
          { allowEmpty: true },
        ),
        maxTokens: normalizeInteger(
          rawSessionSearchAuxiliaryModel.maxTokens,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.session_search.maxTokens,
          { min: 0, max: 1_000_000 },
        ),
      },
      skills_hub: {
        provider: normalizeAuxiliaryProviderSelection(
          rawSkillsHubAuxiliaryModel.provider,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.skills_hub.provider,
        ),
        model: normalizeString(
          rawSkillsHubAuxiliaryModel.model,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.skills_hub.model,
          { allowEmpty: true },
        ),
        maxTokens: normalizeInteger(
          rawSkillsHubAuxiliaryModel.maxTokens,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.skills_hub.maxTokens,
          { min: 0, max: 1_000_000 },
        ),
      },
      eval_judge: {
        provider: normalizeAuxiliaryProviderSelection(
          rawEvalJudgeAuxiliaryModel.provider,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.eval_judge.provider,
        ),
        model: normalizeString(
          rawEvalJudgeAuxiliaryModel.model,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.eval_judge.model,
          { allowEmpty: true },
        ),
        maxTokens: normalizeInteger(
          rawEvalJudgeAuxiliaryModel.maxTokens,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.eval_judge.maxTokens,
          { min: 0, max: 1_000_000 },
        ),
      },
      mcp: {
        provider: normalizeAuxiliaryProviderSelection(
          rawMcpAuxiliaryModel.provider,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.mcp.provider,
        ),
        model: normalizeString(
          rawMcpAuxiliaryModel.model,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.mcp.model,
          { allowEmpty: true },
        ),
        maxTokens: normalizeInteger(
          rawMcpAuxiliaryModel.maxTokens,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.mcp.maxTokens,
          { min: 0, max: 1_000_000 },
        ),
      },
      flush_memories: {
        provider: normalizeAuxiliaryProviderSelection(
          rawFlushMemoriesAuxiliaryModel.provider,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.flush_memories.provider,
        ),
        model: normalizeString(
          rawFlushMemoriesAuxiliaryModel.model,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.flush_memories.model,
          { allowEmpty: true },
        ),
        maxTokens: normalizeInteger(
          rawFlushMemoriesAuxiliaryModel.maxTokens,
          DEFAULT_RUNTIME_CONFIG.auxiliaryModels.flush_memories.maxTokens,
          { min: 0, max: 1_000_000 },
        ),
      },
    },
    container: {
      sandboxMode: normalizeContainerSandboxMode(
        rawContainer.sandboxMode,
        DEFAULT_RUNTIME_CONFIG.container.sandboxMode,
      ),
      image: normalizeString(
        rawContainer.image,
        DEFAULT_RUNTIME_CONFIG.container.image,
        { allowEmpty: false },
      ),
      memory: normalizeString(
        rawContainer.memory,
        DEFAULT_RUNTIME_CONFIG.container.memory,
        { allowEmpty: false },
      ),
      memorySwap: normalizeString(
        rawContainer.memorySwap,
        DEFAULT_RUNTIME_CONFIG.container.memorySwap,
        { allowEmpty: true },
      ),
      cpus: normalizeString(
        rawContainer.cpus,
        DEFAULT_RUNTIME_CONFIG.container.cpus,
        { allowEmpty: false },
      ),
      network: normalizeString(
        rawContainer.network,
        DEFAULT_RUNTIME_CONFIG.container.network,
        { allowEmpty: false },
      ),
      timeoutMs: normalizeInteger(
        rawContainer.timeoutMs,
        DEFAULT_RUNTIME_CONFIG.container.timeoutMs,
        { min: 1_000 },
      ),
      binds: normalizeStringArray(
        rawContainer.binds,
        DEFAULT_RUNTIME_CONFIG.container.binds,
      ),
      additionalMounts: normalizeString(
        rawContainer.additionalMounts,
        DEFAULT_RUNTIME_CONFIG.container.additionalMounts,
        { allowEmpty: true },
      ),
      maxOutputBytes: normalizeInteger(
        rawContainer.maxOutputBytes,
        DEFAULT_RUNTIME_CONFIG.container.maxOutputBytes,
        { min: 1_024 },
      ),
      maxConcurrent: normalizeInteger(
        rawContainer.maxConcurrent,
        DEFAULT_RUNTIME_CONFIG.container.maxConcurrent,
        { min: 1 },
      ),
      persistBashState: normalizeBoolean(
        rawContainer.persistBashState,
        DEFAULT_RUNTIME_CONFIG.container.persistBashState,
      ),
    },
    mcpServers: normalizeMcpServers(rawMcpServers),
    web: {
      search: {
        provider: normalizeWebSearchProvider(
          rawWebSearch.provider,
          DEFAULT_RUNTIME_CONFIG.web.search.provider,
        ),
        fallbackProviders: normalizeWebSearchFallbackProviders(
          rawWebSearch.fallbackProviders,
          DEFAULT_RUNTIME_CONFIG.web.search.fallbackProviders,
        ),
        defaultCount: normalizeInteger(
          rawWebSearch.defaultCount,
          DEFAULT_RUNTIME_CONFIG.web.search.defaultCount,
          { min: 1, max: 10 },
        ),
        cacheTtlMinutes: normalizeInteger(
          rawWebSearch.cacheTtlMinutes,
          DEFAULT_RUNTIME_CONFIG.web.search.cacheTtlMinutes,
          { min: 1, max: 60 },
        ),
        searxngBaseUrl: normalizeString(
          rawWebSearch.searxngBaseUrl,
          DEFAULT_RUNTIME_CONFIG.web.search.searxngBaseUrl,
          { allowEmpty: true },
        ),
        tavilySearchDepth: normalizeTavilySearchDepth(
          rawWebSearch.tavilySearchDepth,
          DEFAULT_RUNTIME_CONFIG.web.search.tavilySearchDepth,
        ),
      },
    },
    media: normalizeMediaConfig(rawMedia, DEFAULT_RUNTIME_CONFIG.media),
    routing: {
      concierge: normalizeRoutingConciergeConfig(
        rawRouting.concierge,
        DEFAULT_RUNTIME_CONFIG.routing.concierge,
      ),
    },
    heartbeat: {
      enabled: normalizeBoolean(
        rawHeartbeat.enabled,
        DEFAULT_RUNTIME_CONFIG.heartbeat.enabled,
      ),
      intervalMs: normalizeInteger(
        rawHeartbeat.intervalMs,
        DEFAULT_RUNTIME_CONFIG.heartbeat.intervalMs,
        { min: 10_000 },
      ),
      channel: normalizeString(
        rawHeartbeat.channel,
        DEFAULT_RUNTIME_CONFIG.heartbeat.channel,
        { allowEmpty: true },
      ),
    },
    memory: {
      decayRate: normalizeNumber(
        rawMemory.decayRate,
        DEFAULT_RUNTIME_CONFIG.memory.decayRate,
        { min: 0, max: 0.95 },
      ),
      consolidationIntervalHours: normalizeInteger(
        rawMemory.consolidationIntervalHours,
        DEFAULT_RUNTIME_CONFIG.memory.consolidationIntervalHours,
        { min: 0, max: 24 * 30 },
      ),
      consolidationLanguage: normalizeString(
        rawMemory.consolidationLanguage,
        DEFAULT_RUNTIME_CONFIG.memory.consolidationLanguage,
        { allowEmpty: false },
      ).toLowerCase(),
      semanticPromptHardCap: normalizeInteger(
        rawMemory.semanticPromptHardCap,
        DEFAULT_RUNTIME_CONFIG.memory.semanticPromptHardCap,
        { min: 1, max: 50 },
      ),
      embedding: {
        provider: normalizeMemoryEmbeddingProviderKind(
          normalizeString(
            isRecord(rawMemory.embedding)
              ? rawMemory.embedding.provider
              : undefined,
            DEFAULT_RUNTIME_CONFIG.memory.embedding.provider,
            { allowEmpty: false },
          ),
          DEFAULT_RUNTIME_CONFIG.memory.embedding.provider,
        ),
        model: normalizeString(
          isRecord(rawMemory.embedding) ? rawMemory.embedding.model : undefined,
          DEFAULT_RUNTIME_CONFIG.memory.embedding.model,
          { allowEmpty: false },
        ),
        revision: normalizeString(
          isRecord(rawMemory.embedding)
            ? rawMemory.embedding.revision
            : undefined,
          DEFAULT_RUNTIME_CONFIG.memory.embedding.revision,
          { allowEmpty: false },
        ),
        dtype: normalizeMemoryEmbeddingDtype(
          normalizeString(
            isRecord(rawMemory.embedding)
              ? rawMemory.embedding.dtype
              : undefined,
            DEFAULT_RUNTIME_CONFIG.memory.embedding.dtype,
            { allowEmpty: false },
          ),
          DEFAULT_RUNTIME_CONFIG.memory.embedding.dtype,
        ),
      },
      queryMode:
        normalizeString(
          rawMemory.queryMode,
          DEFAULT_RUNTIME_CONFIG.memory.queryMode,
          { allowEmpty: false },
        ) === 'no-stopwords'
          ? 'no-stopwords'
          : 'raw',
      backend: normalizeMemoryRecallBackend(
        normalizeString(
          rawMemory.backend,
          DEFAULT_RUNTIME_CONFIG.memory.backend,
          { allowEmpty: false },
        ),
        DEFAULT_RUNTIME_CONFIG.memory.backend,
      ),
      rerank:
        normalizeString(
          rawMemory.rerank,
          DEFAULT_RUNTIME_CONFIG.memory.rerank,
          { allowEmpty: false },
        ) === 'bm25'
          ? 'bm25'
          : 'none',
      tokenizer: normalizeMemoryRecallTokenizer(
        normalizeString(
          rawMemory.tokenizer,
          DEFAULT_RUNTIME_CONFIG.memory.tokenizer,
          { allowEmpty: false },
        ),
        DEFAULT_RUNTIME_CONFIG.memory.tokenizer,
      ),
    },
    ops: {
      healthHost: normalizeString(rawOps.healthHost, defaultOps.healthHost, {
        allowEmpty: false,
      }),
      healthPort,
      webApiToken,
      gatewayBaseUrl: normalizeBaseUrl(
        rawOps.gatewayBaseUrl,
        `http://127.0.0.1:${healthPort}`,
      ),
      gatewayApiToken: normalizeString(resolvedGatewayApiToken, webApiToken, {
        allowEmpty: true,
      }),
      dbPath: normalizedDbPath,
      logLevel: normalizeLogLevel(rawOps.logLevel, defaultOps.logLevel),
    },
    observability: {
      enabled: normalizeBoolean(
        rawObservability.enabled,
        DEFAULT_RUNTIME_CONFIG.observability.enabled,
      ),
      baseUrl: normalizeBaseUrl(rawObservability.baseUrl, hybridBaseUrl),
      ingestPath: normalizeApiPath(
        rawObservability.ingestPath,
        DEFAULT_RUNTIME_CONFIG.observability.ingestPath,
      ),
      statusPath: normalizeApiPath(
        rawObservability.statusPath,
        DEFAULT_RUNTIME_CONFIG.observability.statusPath,
      ),
      botId: normalizeString(rawObservability.botId, hybridDefaultChatbotId, {
        allowEmpty: true,
      }),
      agentId: normalizeString(
        rawObservability.agentId,
        DEFAULT_RUNTIME_CONFIG.observability.agentId,
        { allowEmpty: false },
      ),
      label: normalizeString(
        rawObservability.label,
        DEFAULT_RUNTIME_CONFIG.observability.label,
        { allowEmpty: true },
      ),
      environment: normalizeString(
        rawObservability.environment,
        DEFAULT_RUNTIME_CONFIG.observability.environment,
        { allowEmpty: false },
      ),
      flushIntervalMs: normalizeInteger(
        rawObservability.flushIntervalMs,
        DEFAULT_RUNTIME_CONFIG.observability.flushIntervalMs,
        { min: 1_000, max: 3_600_000 },
      ),
      batchMaxEvents: normalizeInteger(
        rawObservability.batchMaxEvents,
        DEFAULT_RUNTIME_CONFIG.observability.batchMaxEvents,
        { min: 1, max: 1_000 },
      ),
    },
    sessionCompaction: {
      enabled: normalizeBoolean(
        rawSessionCompaction.enabled,
        DEFAULT_RUNTIME_CONFIG.sessionCompaction.enabled,
      ),
      tokenBudget,
      budgetRatio,
      threshold,
      keepRecent,
      summaryMaxChars: normalizeInteger(
        rawSessionCompaction.summaryMaxChars,
        DEFAULT_RUNTIME_CONFIG.sessionCompaction.summaryMaxChars,
        { min: 1_000 },
      ),
      preCompactionMemoryFlush: {
        enabled: normalizeBoolean(
          rawPreFlush.enabled,
          DEFAULT_RUNTIME_CONFIG.sessionCompaction.preCompactionMemoryFlush
            .enabled,
        ),
        maxMessages: normalizeInteger(
          rawPreFlush.maxMessages,
          DEFAULT_RUNTIME_CONFIG.sessionCompaction.preCompactionMemoryFlush
            .maxMessages,
          { min: 8 },
        ),
        maxChars: normalizeInteger(
          rawPreFlush.maxChars,
          DEFAULT_RUNTIME_CONFIG.sessionCompaction.preCompactionMemoryFlush
            .maxChars,
          { min: 4_000 },
        ),
      },
      inLoopGuard: normalizeContextGuardConfig(
        rawInLoopGuard,
        DEFAULT_RUNTIME_CONFIG.sessionCompaction.inLoopGuard,
      ),
    },
    sessionReset: {
      defaultPolicy: {
        mode: normalizeSessionResetMode(
          rawDefaultResetPolicy.mode,
          DEFAULT_RUNTIME_CONFIG.sessionReset.defaultPolicy.mode,
        ),
        atHour: normalizeInteger(
          rawDefaultResetPolicy.atHour,
          DEFAULT_RUNTIME_CONFIG.sessionReset.defaultPolicy.atHour,
          { min: 0, max: 23 },
        ),
        idleMinutes: normalizeInteger(
          rawDefaultResetPolicy.idleMinutes,
          DEFAULT_RUNTIME_CONFIG.sessionReset.defaultPolicy.idleMinutes,
          { min: 1 },
        ),
      },
      byChannelKind: normalizeSessionResetByChannelKind(
        rawResetByChannelKind,
        DEFAULT_RUNTIME_CONFIG.sessionReset.defaultPolicy,
      ),
    },
    sessionRouting: {
      dmScope: normalizeSessionDmScope(
        rawSessionRouting.dmScope,
        DEFAULT_RUNTIME_CONFIG.sessionRouting.dmScope,
      ),
      identityLinks: normalizeSessionIdentityLinks(
        rawSessionRouting.identityLinks,
      ),
    },
    promptHooks: {
      bootstrapEnabled: normalizeBoolean(
        rawPromptHooks.bootstrapEnabled,
        DEFAULT_RUNTIME_CONFIG.promptHooks.bootstrapEnabled,
      ),
      memoryEnabled: normalizeBoolean(
        rawPromptHooks.memoryEnabled,
        DEFAULT_RUNTIME_CONFIG.promptHooks.memoryEnabled,
      ),
      safetyEnabled: normalizeBoolean(
        rawPromptHooks.safetyEnabled,
        DEFAULT_RUNTIME_CONFIG.promptHooks.safetyEnabled,
      ),
      proactivityEnabled: normalizeBoolean(
        rawPromptHooks.proactivityEnabled,
        DEFAULT_RUNTIME_CONFIG.promptHooks.proactivityEnabled,
      ),
    },
    proactive: {
      activeHours: {
        enabled: normalizeBoolean(
          rawActiveHours.enabled,
          DEFAULT_RUNTIME_CONFIG.proactive.activeHours.enabled,
        ),
        timezone: normalizeString(
          rawActiveHours.timezone,
          DEFAULT_RUNTIME_CONFIG.proactive.activeHours.timezone,
          { allowEmpty: true },
        ),
        startHour: normalizeInteger(
          rawActiveHours.startHour,
          DEFAULT_RUNTIME_CONFIG.proactive.activeHours.startHour,
          { min: 0, max: 23 },
        ),
        endHour: normalizeInteger(
          rawActiveHours.endHour,
          DEFAULT_RUNTIME_CONFIG.proactive.activeHours.endHour,
          { min: 0, max: 23 },
        ),
        queueOutsideHours: normalizeBoolean(
          rawActiveHours.queueOutsideHours,
          DEFAULT_RUNTIME_CONFIG.proactive.activeHours.queueOutsideHours,
        ),
      },
      delegation: {
        enabled: normalizeBoolean(
          rawDelegation.enabled,
          DEFAULT_RUNTIME_CONFIG.proactive.delegation.enabled,
        ),
        model: normalizeString(
          rawDelegation.model,
          DEFAULT_RUNTIME_CONFIG.proactive.delegation.model,
          { allowEmpty: true },
        ),
        maxConcurrent: normalizeInteger(
          rawDelegation.maxConcurrent,
          DEFAULT_RUNTIME_CONFIG.proactive.delegation.maxConcurrent,
          { min: 1, max: 8 },
        ),
        maxDepth: normalizeInteger(
          rawDelegation.maxDepth,
          DEFAULT_RUNTIME_CONFIG.proactive.delegation.maxDepth,
          { min: 1, max: 4 },
        ),
        maxPerTurn: normalizeInteger(
          rawDelegation.maxPerTurn,
          DEFAULT_RUNTIME_CONFIG.proactive.delegation.maxPerTurn,
          { min: 1, max: 8 },
        ),
      },
      autoRetry: {
        enabled: normalizeBoolean(
          rawAutoRetry.enabled,
          DEFAULT_RUNTIME_CONFIG.proactive.autoRetry.enabled,
        ),
        maxAttempts: normalizeInteger(
          rawAutoRetry.maxAttempts,
          DEFAULT_RUNTIME_CONFIG.proactive.autoRetry.maxAttempts,
          { min: 1, max: 8 },
        ),
        baseDelayMs: normalizeInteger(
          rawAutoRetry.baseDelayMs,
          DEFAULT_RUNTIME_CONFIG.proactive.autoRetry.baseDelayMs,
          { min: 100, max: 120_000 },
        ),
        maxDelayMs: normalizeInteger(
          rawAutoRetry.maxDelayMs,
          DEFAULT_RUNTIME_CONFIG.proactive.autoRetry.maxDelayMs,
          { min: 100, max: 600_000 },
        ),
      },
      ralph: {
        maxIterations: normalizeInteger(
          rawRalph.maxIterations,
          DEFAULT_RUNTIME_CONFIG.proactive.ralph.maxIterations,
          { min: -1, max: 64 },
        ),
      },
    },
    scheduler: {
      jobs: normalizeSchedulerJobList(
        rawScheduler.jobs,
        DEFAULT_RUNTIME_CONFIG.scheduler.jobs,
      ),
    },
  };
}

function loadConfigPatchFromDisk(): {
  observedFile: RuntimeConfigObservedFile;
  patch: DeepPartial<RuntimeConfig>;
  source: Record<string, unknown>;
} {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      observedFile: {
        exists: false,
        content: null,
      },
      patch: {},
      source: {},
    };
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return {
    observedFile: {
      exists: true,
      content: raw,
    },
    patch: parseConfigPatch(parsed),
    source: isRecord(parsed) ? (parsed as Record<string, unknown>) : {},
  };
}

function buildSerializableConfig(
  config: RuntimeConfig,
  opts?: { omitImplicitSandboxMode?: boolean },
  sourceConfig?: Record<string, unknown>,
): Record<string, unknown> {
  const serializable = cloneConfig(config) as unknown as Record<
    string,
    unknown
  >;
  preserveSecretInputs(serializable, sourceConfig ?? {});
  const serializableCodex = isRecord(serializable.codex)
    ? serializable.codex
    : null;
  if (serializableCodex) {
    delete (serializableCodex as { models?: string[] }).models;
  }
  const serializableContainer = isRecord(serializable.container)
    ? serializable.container
    : null;
  if (
    serializableContainer &&
    opts?.omitImplicitSandboxMode &&
    serializableContainer.sandboxMode ===
      DEFAULT_RUNTIME_CONFIG.container.sandboxMode
  ) {
    delete (serializableContainer as { sandboxMode?: ContainerSandboxMode })
      .sandboxMode;
  }

  return serializable;
}

function serializeConfigFile(
  config: RuntimeConfig,
  opts?: { omitImplicitSandboxMode?: boolean },
  sourceConfig?: Record<string, unknown>,
): string {
  return `${JSON.stringify(buildSerializableConfig(config, opts, sourceConfig), null, 2)}\n`;
}

function writeConfigFile(
  config: RuntimeConfig,
  opts?: { omitImplicitSandboxMode?: boolean },
  meta?: RuntimeConfigChangeMeta,
  sourceConfig?: Record<string, unknown>,
): boolean {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const nextText = serializeConfigFile(config, opts, sourceConfig);
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const currentText = fs.readFileSync(CONFIG_PATH, 'utf-8');
      if (currentText === nextText) return false;
    } catch {
      // fall through and rewrite the file
    }
  }

  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, nextText, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
  syncRuntimeConfigRevisionState(CONFIG_PATH, meta, {
    exists: true,
    content: nextText,
  });
  return true;
}

function applyConfig(next: RuntimeConfig): void {
  const prev = currentConfig;
  currentConfig = cloneConfig(next);
  currentConfigLoadError = null;

  if (JSON.stringify(prev) === JSON.stringify(currentConfig)) return;
  for (const listener of listeners) {
    try {
      listener(cloneConfig(currentConfig), cloneConfig(prev));
    } catch (err) {
      console.warn(
        `[runtime-config] listener failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function loadRuntimeConfigFromSources(
  syncMeta?: RuntimeConfigChangeMeta,
): RuntimeConfig {
  const {
    observedFile,
    patch: diskPatch,
    source: diskSource,
  } = loadConfigPatchFromDisk();
  syncRuntimeConfigRevisionState(CONFIG_PATH, syncMeta, observedFile);
  const rawContainer = isRecord(diskPatch.container) ? diskPatch.container : {};
  currentConfigSource = cloneConfig(diskSource);
  currentConfigMetadata = {
    containerSandboxModeExplicit: hasOwn(rawContainer, 'sandboxMode'),
    containerMaxConcurrentExplicit: hasOwn(rawContainer, 'maxConcurrent'),
  };
  return normalizeRuntimeConfig(diskPatch);
}

function reloadRuntimeConfigFromSources(
  syncMeta?: RuntimeConfigChangeMeta,
): RuntimeConfig {
  const next = loadRuntimeConfigFromSources(syncMeta);
  applyConfig(next);
  return cloneConfig(currentConfig);
}

function reloadFromDisk(trigger: string): void {
  try {
    reloadRuntimeConfigFromSources({
      route: `runtime-config.reload:${trigger}`,
      source: 'external',
    });
  } catch (err) {
    currentConfigLoadError = {
      trigger,
      path: CONFIG_PATH,
      message: err instanceof Error ? err.message : String(err),
    };
    console.warn(
      `[runtime-config] reload failed (${trigger}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function scheduleReload(trigger: string): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = startDetachedTimer(() => {
    reloadTimer = null;
    reloadFromDisk(trigger);
  }, 120);
}

function scheduleWatcherRestart(reason: string): void {
  if (isRuntimeConfigWatcherDisabled() || watcherPermanentlyDisabled) return;
  if (watcherRestartTimer) return;
  if (watcherStableTimer) {
    clearTimeout(watcherStableTimer);
    watcherStableTimer = null;
  }
  if (watcherRetryAttempt >= WATCHER_RETRY_MAX_ATTEMPTS) {
    console.warn(
      `[runtime-config] watcher disabled after ${WATCHER_RETRY_MAX_ATTEMPTS} retries (${reason})`,
    );
    return;
  }

  watcherRetryAttempt += 1;
  const delay = Math.min(
    WATCHER_RETRY_BASE_DELAY_MS * 2 ** (watcherRetryAttempt - 1),
    WATCHER_RETRY_MAX_DELAY_MS,
  );
  console.warn(
    `[runtime-config] watcher restart in ${delay}ms (attempt ${watcherRetryAttempt}/${WATCHER_RETRY_MAX_ATTEMPTS})`,
  );
  watcherRestartTimer = startDetachedTimer(() => {
    watcherRestartTimer = null;
    startWatcher();
  }, delay);
}

function markWatcherStable(activeWatcher: fs.FSWatcher): void {
  if (configWatcher !== activeWatcher) return;
  watcherRetryAttempt = 0;
  if (watcherStableTimer) {
    clearTimeout(watcherStableTimer);
    watcherStableTimer = null;
  }
}

function startWatcher(): void {
  if (isRuntimeConfigWatcherDisabled() || watcherPermanentlyDisabled) return;
  if (configWatcher) return;

  try {
    configWatcher = fs.watch(
      path.dirname(CONFIG_PATH),
      { persistent: false },
      (_event, filename) => {
        markWatcherStable(activeWatcher);
        if (!filename) {
          scheduleReload('unknown');
          return;
        }
        if (filename.toString() !== path.basename(CONFIG_PATH)) return;
        scheduleReload(`watch:${filename.toString()}`);
      },
    );
    const activeWatcher = configWatcher;
    watcherStableTimer = startDetachedTimer(() => {
      markWatcherStable(activeWatcher);
    }, WATCHER_STABLE_RESET_DELAY_MS);
    if (watcherRestartTimer) {
      clearTimeout(watcherRestartTimer);
      watcherRestartTimer = null;
    }

    configWatcher.on('error', (err) => {
      const reason = err instanceof Error ? err.message : String(err);
      configWatcher?.close();
      configWatcher = null;
      if (watcherStableTimer) {
        clearTimeout(watcherStableTimer);
        watcherStableTimer = null;
      }
      if (!shouldRetryWatcherError(err)) {
        disableWatcher(reason);
        return;
      }
      console.warn(`[runtime-config] watcher error: ${reason}`);
      scheduleWatcherRestart(`watcher error: ${reason}`);
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!shouldRetryWatcherError(err)) {
      disableWatcher(reason);
      return;
    }
    console.warn(`[runtime-config] watcher setup failed: ${reason}`);
    scheduleWatcherRestart(`watcher setup failed: ${reason}`);
  }
}

function ensureInitialConfigFile(): void {
  if (fs.existsSync(CONFIG_PATH)) return;
  const seeded = normalizeRuntimeConfig();
  writeConfigFile(
    seeded,
    { omitImplicitSandboxMode: true },
    {
      route: 'runtime-config.seed-defaults',
      source: 'system',
    },
  );
}

function migrateConfigSchemaOnStartup(): void {
  if (!fs.existsSync(CONFIG_PATH)) return;

  let raw: string;
  let parsed: unknown;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    console.warn(
      `[runtime-config] schema migration skipped (invalid JSON): ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!isRecord(parsed)) {
    console.warn(
      '[runtime-config] schema migration skipped: config.json is not an object',
    );
    return;
  }

  const previousVersion =
    typeof parsed.version === 'number' ? parsed.version : null;
  let migrated: RuntimeConfig;
  try {
    migrated = normalizeRuntimeConfig(parseConfigPatch(parsed));
  } catch (err) {
    console.warn(
      `[runtime-config] schema migration skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (migrated.deployment.mode === 'cloud' && !migrated.deployment.public_url) {
    console.warn(
      '[runtime-config] deployment.mode is "cloud" but deployment.public_url is empty; inbound webhooks and public callbacks may fail until a public URL is configured',
    );
  }

  try {
    const parsedRecord = parsed as Record<string, unknown>;
    const rawContainer = isRecord(parsedRecord.container)
      ? parsedRecord.container
      : {};
    const changed = writeConfigFile(
      migrated,
      {
        omitImplicitSandboxMode: !hasOwn(rawContainer, 'sandboxMode'),
      },
      {
        route: 'runtime-config.migrate-schema',
        source: 'system',
      },
      parsedRecord,
    );
    if (!changed) return;
    const from = previousVersion == null ? 'unknown' : String(previousVersion);
    if (previousVersion !== CONFIG_VERSION) {
      console.info(
        `[runtime-config] migrated config schema from v${from} to v${CONFIG_VERSION}`,
      );
    } else {
      console.info(
        `[runtime-config] normalized config schema v${CONFIG_VERSION} (filled defaults/canonicalized values)`,
      );
    }
  } catch (err) {
    console.warn(
      `[runtime-config] schema migration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function initializeRuntimeConfig(): void {
  ensureInitialConfigFile();
  migrateConfigSchemaOnStartup();
  reloadFromDisk('startup');
  startWatcher();
}

initializeRuntimeConfig();

export function runtimeConfigPath(): string {
  return CONFIG_PATH;
}

export function ensureRuntimeConfigFile(): boolean {
  if (fs.existsSync(CONFIG_PATH)) return false;
  ensureInitialConfigFile();
  reloadFromDisk('ensure-file');
  return true;
}

export function reloadRuntimeConfig(trigger = 'manual'): RuntimeConfig {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }

  try {
    return reloadRuntimeConfigFromSources({
      route: `runtime-config.reload:${trigger}`,
      source: 'external',
    });
  } catch (err) {
    currentConfigLoadError = {
      trigger,
      path: CONFIG_PATH,
      message: err instanceof Error ? err.message : String(err),
    };
    throw new Error(
      `Failed to reload runtime config (${trigger}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function getRuntimeConfig(): RuntimeConfig {
  return cloneConfig(currentConfig);
}

export function getRuntimeConfigLoadError(): RuntimeConfigLoadError | null {
  return currentConfigLoadError ? { ...currentConfigLoadError } : null;
}

export function resolveDefaultAgentId(
  config: Pick<RuntimeConfig, 'agents'> = currentConfig,
): string {
  const configured = normalizeString(
    config.agents.defaultAgentId,
    DEFAULT_AGENT_ID,
    { allowEmpty: false },
  );
  const hasConfiguredAgent = (config.agents.list ?? []).some(
    (entry) =>
      normalizeString(entry.id, '', {
        allowEmpty: false,
      }) === configured,
  );
  return hasConfiguredAgent ? configured : DEFAULT_AGENT_ID;
}

export function resolveSkillAutonomyLevel(
  config: Pick<RuntimeConfig, 'skills'> = currentConfig,
  agentId: string,
  skillName: string,
): SkillAutonomyLevel {
  const defaultLevel = config.skills.autonomy.defaultLevel;
  if (!agentId || !skillName) {
    throw new Error(
      'resolveSkillAutonomyLevel requires non-empty agentId and skillName.',
    );
  }

  return (
    getSkillAutonomyRuleIndex(config.skills.autonomy)
      .get(agentId)
      ?.get(skillName) ?? defaultLevel
  );
}

export function isContainerSandboxModeExplicit(): boolean {
  return currentConfigMetadata.containerSandboxModeExplicit;
}

export function isContainerMaxConcurrentExplicit(): boolean {
  return currentConfigMetadata.containerMaxConcurrentExplicit;
}

export function onRuntimeConfigChange(
  listener: RuntimeConfigChangeListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type {
  RuntimeConfigChangeMeta,
  RuntimeConfigRevision,
  RuntimeConfigRevisionState,
  RuntimeConfigRevisionStateMetadata,
  RuntimeConfigRevisionSummary,
  RuntimeRevisionAssetType,
};

export function saveRuntimeConfig(
  next: RuntimeConfig,
  meta?: RuntimeConfigChangeMeta,
): RuntimeConfig {
  const normalized = normalizeRuntimeConfig(next);
  const sandboxModeExplicit =
    currentConfigMetadata.containerSandboxModeExplicit ||
    normalized.container.sandboxMode !==
      DEFAULT_RUNTIME_CONFIG.container.sandboxMode;
  const maxConcurrentExplicit =
    currentConfigMetadata.containerMaxConcurrentExplicit ||
    normalized.container.maxConcurrent !==
      DEFAULT_RUNTIME_CONFIG.container.maxConcurrent;
  currentConfigMetadata = {
    containerSandboxModeExplicit: sandboxModeExplicit,
    containerMaxConcurrentExplicit: maxConcurrentExplicit,
  };
  const nextSource = buildSerializableConfig(
    normalized,
    {
      omitImplicitSandboxMode: !sandboxModeExplicit,
    },
    currentConfigSource,
  );
  writeConfigFile(
    normalized,
    {
      omitImplicitSandboxMode: !sandboxModeExplicit,
    },
    meta,
    currentConfigSource,
  );
  currentConfigSource = cloneConfig(nextSource);
  applyConfig(normalized);
  return cloneConfig(normalized);
}

function saveRuntimeConfigSource(
  source: Record<string, unknown>,
  meta?: RuntimeConfigChangeMeta,
): RuntimeConfig {
  const normalized = normalizeRuntimeConfig(parseConfigPatch(source));
  const rawContainer = isRecord(source.container) ? source.container : {};
  const sandboxModeExplicit =
    hasOwn(rawContainer, 'sandboxMode') ||
    normalized.container.sandboxMode !==
      DEFAULT_RUNTIME_CONFIG.container.sandboxMode;
  const maxConcurrentExplicit =
    hasOwn(rawContainer, 'maxConcurrent') ||
    normalized.container.maxConcurrent !==
      DEFAULT_RUNTIME_CONFIG.container.maxConcurrent;
  currentConfigMetadata = {
    containerSandboxModeExplicit: sandboxModeExplicit,
    containerMaxConcurrentExplicit: maxConcurrentExplicit,
  };
  const nextSource = buildSerializableConfig(
    normalized,
    {
      omitImplicitSandboxMode: !sandboxModeExplicit,
    },
    source,
  );
  writeConfigFile(
    normalized,
    {
      omitImplicitSandboxMode: !sandboxModeExplicit,
    },
    meta,
    source,
  );
  currentConfigSource = cloneConfig(nextSource);
  applyConfig(normalized);
  return cloneConfig(normalized);
}

export function updateRuntimeConfig(
  mutator: (draft: RuntimeConfig) => void,
  meta?: RuntimeConfigChangeMeta,
): RuntimeConfig {
  let baseConfig = currentConfig;
  try {
    baseConfig = loadRuntimeConfigFromSources({
      route: 'runtime-config.refresh-before-save',
      source: 'external',
    });
  } catch (err) {
    console.warn(
      `[runtime-config] update using in-memory config after reload failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const draft = cloneConfig(baseConfig);
  mutator(draft);
  return saveRuntimeConfig(draft, meta);
}

export function setRuntimeConfigSecretInput(
  secretPath: RuntimeConfigSecretInputPath,
  value: SecretInput | '',
  meta?: RuntimeConfigChangeMeta,
): RuntimeConfig {
  let baseSource = currentConfigSource;
  try {
    loadRuntimeConfigFromSources({
      route: 'runtime-config.refresh-before-secret-save',
      source: 'external',
    });
    baseSource = currentConfigSource;
  } catch (err) {
    console.warn(
      `[runtime-config] secret input update using in-memory config after reload failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const draftSource = cloneConfig(baseSource);
  setSecretInputOnSource(draftSource, secretPath, value);
  return saveRuntimeConfigSource(draftSource, meta);
}

export function listRuntimeConfigRevisions(): RuntimeConfigRevisionSummary[] {
  return listTrackedRuntimeConfigRevisions(CONFIG_PATH);
}

export function listRuntimeAssetRevisions(
  assetType: RuntimeRevisionAssetType,
  assetPath: string,
): RuntimeConfigRevisionSummary[] {
  return listTrackedRuntimeAssetRevisions(assetType, assetPath);
}

export function getRuntimeConfigRevision(
  revisionId: number,
): RuntimeConfigRevision | null {
  return getTrackedRuntimeConfigRevision(CONFIG_PATH, revisionId);
}

export function getRuntimeAssetRevision(
  assetType: RuntimeRevisionAssetType,
  assetPath: string,
  revisionId: number,
): RuntimeConfigRevision | null {
  return getTrackedRuntimeAssetRevision(assetType, assetPath, revisionId);
}

export function getLastKnownGoodRuntimeConfigState(): RuntimeConfigRevisionState | null {
  return getTrackedRuntimeConfigRevisionState(CONFIG_PATH);
}

export function getLastKnownGoodRuntimeAssetState(
  assetType: RuntimeRevisionAssetType,
  assetPath: string,
): RuntimeConfigRevisionState | null {
  return getTrackedRuntimeAssetRevisionState(assetType, assetPath);
}

export function getLastKnownGoodRuntimeConfigMetadata(): RuntimeConfigRevisionStateMetadata | null {
  return getTrackedRuntimeConfigRevisionStateMetadata(CONFIG_PATH);
}

export function getLastKnownGoodRuntimeAssetMetadata(
  assetType: RuntimeRevisionAssetType,
  assetPath: string,
): RuntimeConfigRevisionStateMetadata | null {
  return getTrackedRuntimeAssetRevisionStateMetadata(assetType, assetPath);
}

export function deleteRuntimeConfigRevision(revisionId: number): boolean {
  return deleteTrackedRuntimeConfigRevision(CONFIG_PATH, revisionId);
}

export function deleteRuntimeAssetRevision(
  assetType: RuntimeRevisionAssetType,
  assetPath: string,
  revisionId: number,
): boolean {
  return deleteTrackedRuntimeAssetRevision(assetType, assetPath, revisionId);
}

export function clearRuntimeConfigRevisions(): number {
  return clearTrackedRuntimeConfigRevisions(CONFIG_PATH);
}

export function clearRuntimeAssetRevisions(
  assetType: RuntimeRevisionAssetType,
  assetPath: string,
): number {
  return clearTrackedRuntimeAssetRevisions(assetType, assetPath);
}

export function syncRuntimeAssetRevisionState(
  assetType: RuntimeRevisionAssetType,
  assetPath: string,
  meta?: RuntimeConfigChangeMeta,
  observedFile?: RuntimeConfigObservedFile,
): { changed: boolean; previousMd5: string | null; currentMd5: string | null } {
  return syncTrackedRuntimeAssetRevisionState(
    assetType,
    assetPath,
    meta,
    observedFile,
  );
}

export function restoreRuntimeConfigRevision(
  revisionId: number,
  meta?: RuntimeConfigChangeMeta,
): RuntimeConfig {
  const revision = getRuntimeConfigRevision(revisionId);
  if (!revision) {
    throw new Error(`Config revision ${revisionId} was not found.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(revision.content) as unknown;
  } catch (err) {
    throw new Error(
      `Config revision ${revisionId} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return saveRuntimeConfig(
    normalizeRuntimeConfig(parsed as DeepPartial<RuntimeConfig>),
    meta,
  );
}

export function restoreLastKnownGoodRuntimeConfig(
  meta?: RuntimeConfigChangeMeta,
): RuntimeConfig {
  const state = getLastKnownGoodRuntimeConfigState();
  if (!state) {
    throw new Error('No last-known-good runtime config snapshot was found.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(state.content) as unknown;
  } catch (err) {
    throw new Error(
      `Last-known-good runtime config snapshot is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      'Last-known-good runtime config snapshot is not an object.',
    );
  }

  return saveRuntimeConfigSource(parsed as Record<string, unknown>, meta);
}

export function restoreRuntimeAssetRevision(
  assetType: RuntimeRevisionAssetType,
  assetPath: string,
  revisionId: number,
  meta?: RuntimeConfigChangeMeta,
): string {
  return restoreTrackedRuntimeAssetRevision(
    assetType,
    assetPath,
    revisionId,
    meta,
  );
}

export function restoreRuntimeSkillRevision(
  assetPath: string,
  revisionId: number,
  meta?: RuntimeConfigChangeMeta,
): string {
  return restoreRuntimeAssetRevision('skill', assetPath, revisionId, meta);
}

export function restoreRuntimeKnowledgeRevision(
  assetPath: string,
  revisionId: number,
  meta?: RuntimeConfigChangeMeta,
): string {
  return restoreRuntimeAssetRevision('knowledge', assetPath, revisionId, meta);
}

export function restoreRuntimeCvRevision(
  assetPath: string,
  revisionId: number,
  meta?: RuntimeConfigChangeMeta,
): string {
  return restoreRuntimeAssetRevision('cv', assetPath, revisionId, meta);
}

export function restoreRuntimeClassifierRevision(
  assetPath: string,
  revisionId: number,
  meta?: RuntimeConfigChangeMeta,
): string {
  return restoreRuntimeAssetRevision('classifier', assetPath, revisionId, meta);
}

export function restoreRuntimeTeamRevision(
  assetPath: string,
  revisionId: number,
  meta?: RuntimeConfigChangeMeta,
): string {
  return restoreRuntimeAssetRevision('team', assetPath, revisionId, meta);
}

export function runtimeConfigRevisionPath(): string {
  return runtimeConfigRevisionStorePath();
}

export function isSecurityTrustAccepted(
  config: RuntimeConfig = currentConfig,
): boolean {
  return Boolean(
    config.security.trustModelAccepted &&
      config.security.trustModelAcceptedAt &&
      config.security.trustModelVersion === SECURITY_POLICY_VERSION,
  );
}

export function acceptSecurityTrustModel(params?: {
  acceptedAt?: string;
  acceptedBy?: string | null;
  policyVersion?: string;
}): RuntimeConfig {
  const acceptedAt = normalizeString(
    params?.acceptedAt,
    new Date().toISOString(),
    { allowEmpty: false },
  );
  const acceptedBy = normalizeString(params?.acceptedBy ?? '', '', {
    allowEmpty: true,
  });
  const policyVersion = normalizeString(
    params?.policyVersion,
    SECURITY_POLICY_VERSION,
    { allowEmpty: false },
  );

  return updateRuntimeConfig((draft) => {
    draft.security.trustModelAccepted = true;
    draft.security.trustModelAcceptedAt = acceptedAt;
    draft.security.trustModelAcceptedBy = acceptedBy;
    draft.security.trustModelVersion = policyVersion;
  });
}
