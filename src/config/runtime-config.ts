import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CODEX_DEFAULT_BASE_URL } from '../auth/codex-auth.js';
import type { LocalProviderConfig } from '../providers/local-types.js';
import type { McpServerConfig } from '../types.js';

export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_VERSION = 9;
export const SECURITY_POLICY_VERSION = '2026-02-28';
const LEGACY_DEFAULT_DB_PATH = 'data/hybridclaw.db';
const DEFAULT_RUNTIME_HOME_DIR = path.join(os.homedir(), '.hybridclaw');
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

export type DiscordGroupPolicy = 'open' | 'allowlist' | 'disabled';
export type DiscordSendPolicy = 'open' | 'allowlist' | 'disabled';
export type DiscordCommandMode = 'public' | 'restricted';
export type DiscordChannelMode = 'off' | 'mention' | 'free';
export type DiscordTypingMode = 'instant' | 'thinking' | 'streaming' | 'never';
export type DiscordHumanDelayMode = 'off' | 'natural' | 'custom';
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
export type SchedulerScheduleKind = 'at' | 'every' | 'cron';
export type SchedulerActionKind = 'agent_turn' | 'system_event';
export type SchedulerDeliveryKind = 'channel' | 'last-channel' | 'webhook';
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

export interface RuntimeSchedulerJob {
  id: string;
  name?: string;
  description?: string;
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

export interface RuntimeConfig {
  version: number;
  security: RuntimeSecurityConfig;
  skills: {
    extraDirs: string[];
    disabled: string[];
  };
  discord: {
    prefix: string;
    guildMembersIntent: boolean;
    presenceIntent: boolean;
    respondToAllMessages: boolean;
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
  local: LocalProviderConfig;
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
  heartbeat: {
    enabled: boolean;
    intervalMs: number;
    channel: string;
  };
  memory: {
    decayRate: number;
    consolidationIntervalHours: number;
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

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  version: CONFIG_VERSION,
  security: {
    trustModelAccepted: false,
    trustModelAcceptedAt: '',
    trustModelVersion: '',
    trustModelAcceptedBy: '',
  },
  skills: {
    extraDirs: [],
    disabled: [],
  },
  discord: {
    prefix: '!claw',
    guildMembersIntent: false,
    presenceIntent: false,
    respondToAllMessages: false,
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
  hybridai: {
    baseUrl: 'https://hybridai.one',
    defaultModel: 'gpt-5-nano',
    defaultChatbotId: '',
    maxTokens: 4_096,
    enableRag: true,
    models: ['gpt-5-nano', 'gpt-5-mini', 'gpt-5'],
  },
  codex: {
    baseUrl: CODEX_DEFAULT_BASE_URL,
    models: [...DEFAULT_CODEX_MODEL_LIST],
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
      vllm: {
        enabled: false,
        baseUrl: 'http://127.0.0.1:8000/v1',
        apiKey: '',
      },
    },
    discovery: {
      enabled: true,
      intervalMs: 300_000,
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
  heartbeat: {
    enabled: true,
    intervalMs: 1_800_000,
    channel: '',
  },
  memory: {
    decayRate: 0.1,
    consolidationIntervalHours: 24,
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
    jobs: [],
  },
};

const CONFIG_PATH = path.join(DEFAULT_RUNTIME_HOME_DIR, CONFIG_FILE_NAME);

let currentConfig: RuntimeConfig = cloneConfig(DEFAULT_RUNTIME_CONFIG);
let currentConfigMetadata = {
  containerSandboxModeExplicit: false,
};
let configWatcher: fs.FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<RuntimeConfigChangeListener>();
const WATCHER_RETRY_BASE_DELAY_MS = 1_000;
const WATCHER_RETRY_MAX_DELAY_MS = 60_000;
const WATCHER_RETRY_MAX_ATTEMPTS = 10;
let watcherRetryAttempt = 0;
let watcherRestartTimer: ReturnType<typeof setTimeout> | null = null;

function isRuntimeConfigWatcherDisabled(): boolean {
  const raw = String(process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER || '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
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

function expandHomePath(value: string): string {
  const normalized = value.trim();
  if (normalized === '~') return os.homedir();
  if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  return normalized;
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

function normalizeSchedulerScheduleKind(
  value: unknown,
  fallback: SchedulerScheduleKind,
): SchedulerScheduleKind {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'at' || normalized === 'every' || normalized === 'cron')
    return normalized;
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
    const actionMessage = normalizeString(rawAction.message, '', {
      allowEmpty: false,
    });
    if (!actionMessage) continue;
    const name = normalizeString(item.name, '', { allowEmpty: true });
    const description = normalizeString(item.description, '', {
      allowEmpty: true,
    });

    jobs.push({
      id: jobId,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      schedule: {
        kind: scheduleKind,
        at: atIso,
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

function normalizeContainerSandboxMode(
  value: unknown,
  fallback: ContainerSandboxMode,
): ContainerSandboxMode {
  const normalized = normalizeString(value, fallback, {
    allowEmpty: false,
  }).toLowerCase();
  return normalized === 'host' ? 'host' : 'container';
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
  const raw = patch ?? {};

  const rawSecurity = isRecord(raw.security) ? raw.security : {};
  const rawSkills = isRecord(raw.skills) ? raw.skills : {};
  const rawDiscord = isRecord(raw.discord) ? raw.discord : {};
  const rawHybridAi = isRecord(raw.hybridai) ? raw.hybridai : {};
  const rawCodex = isRecord(raw.codex) ? raw.codex : {};
  const rawLocal = isRecord(raw.local) ? raw.local : {};
  const rawLocalBackends = isRecord(rawLocal.backends) ? rawLocal.backends : {};
  const rawOllamaBackend = isRecord(rawLocalBackends.ollama)
    ? rawLocalBackends.ollama
    : {};
  const rawLmStudioBackend = isRecord(rawLocalBackends.lmstudio)
    ? rawLocalBackends.lmstudio
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
  const healthPort = normalizeInteger(
    rawOps.healthPort,
    defaultOps.healthPort,
    { min: 1, max: 65_535 },
  );
  const webApiToken = normalizeString(
    rawOps.webApiToken,
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
    skills: {
      extraDirs: normalizeStringArray(
        rawSkills.extraDirs,
        DEFAULT_RUNTIME_CONFIG.skills.extraDirs,
      ),
      disabled: normalizeStringArray(
        rawSkills.disabled,
        DEFAULT_RUNTIME_CONFIG.skills.disabled,
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
      respondToAllMessages: normalizeBoolean(
        rawDiscord.respondToAllMessages,
        DEFAULT_RUNTIME_CONFIG.discord.respondToAllMessages,
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
        vllm: {
          enabled: normalizeBoolean(
            rawVllmBackend.enabled,
            DEFAULT_RUNTIME_CONFIG.local.backends.vllm.enabled,
          ),
          baseUrl: normalizeBaseUrl(
            rawVllmBackend.baseUrl,
            DEFAULT_RUNTIME_CONFIG.local.backends.vllm.baseUrl,
          ),
          apiKey: normalizeString(
            rawVllmBackend.apiKey,
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
      gatewayApiToken: normalizeString(rawOps.gatewayApiToken, webApiToken, {
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

function loadConfigPatchFromDisk(): DeepPartial<RuntimeConfig> {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return parseConfigPatch(parsed);
}

function buildSerializableConfig(
  config: RuntimeConfig,
  opts?: { omitImplicitSandboxMode?: boolean },
): RuntimeConfig & {
  container: RuntimeConfig['container'] & {
    sandboxMode?: ContainerSandboxMode;
  };
} {
  const serializable = cloneConfig(config) as RuntimeConfig & {
    container: RuntimeConfig['container'] & {
      sandboxMode?: ContainerSandboxMode;
    };
  };
  if (
    opts?.omitImplicitSandboxMode &&
    serializable.container.sandboxMode ===
      DEFAULT_RUNTIME_CONFIG.container.sandboxMode
  ) {
    delete (serializable.container as { sandboxMode?: ContainerSandboxMode })
      .sandboxMode;
  }

  return serializable;
}

function serializeConfigFile(
  config: RuntimeConfig,
  opts?: { omitImplicitSandboxMode?: boolean },
): string {
  return `${JSON.stringify(buildSerializableConfig(config, opts), null, 2)}\n`;
}

function writeConfigFile(
  config: RuntimeConfig,
  opts?: { omitImplicitSandboxMode?: boolean },
): boolean {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const nextText = serializeConfigFile(config, opts);
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const currentText = fs.readFileSync(CONFIG_PATH, 'utf-8');
      if (currentText === nextText) return false;
    } catch {
      // fall through and rewrite the file
    }
  }

  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, nextText, 'utf-8');
  fs.renameSync(tmpPath, CONFIG_PATH);
  return true;
}

function applyConfig(next: RuntimeConfig): void {
  const prev = currentConfig;
  currentConfig = cloneConfig(next);

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

function loadRuntimeConfigFromSources(): RuntimeConfig {
  const diskPatch = loadConfigPatchFromDisk();
  const rawContainer = isRecord(diskPatch.container) ? diskPatch.container : {};
  currentConfigMetadata = {
    containerSandboxModeExplicit: hasOwn(rawContainer, 'sandboxMode'),
  };
  return normalizeRuntimeConfig(diskPatch);
}

function reloadFromDisk(trigger: string): void {
  try {
    const next = loadRuntimeConfigFromSources();
    applyConfig(next);
  } catch (err) {
    console.warn(
      `[runtime-config] reload failed (${trigger}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function scheduleReload(trigger: string): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloadFromDisk(trigger);
  }, 120);
}

function scheduleWatcherRestart(reason: string): void {
  if (isRuntimeConfigWatcherDisabled()) return;
  if (watcherRestartTimer) return;
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
  watcherRestartTimer = setTimeout(() => {
    watcherRestartTimer = null;
    startWatcher();
  }, delay);
}

function startWatcher(): void {
  if (isRuntimeConfigWatcherDisabled()) return;
  if (configWatcher) return;

  try {
    configWatcher = fs.watch(
      path.dirname(CONFIG_PATH),
      { persistent: false },
      (_event, filename) => {
        if (!filename) {
          scheduleReload('unknown');
          return;
        }
        if (filename.toString() !== path.basename(CONFIG_PATH)) return;
        scheduleReload(`watch:${filename.toString()}`);
      },
    );
    watcherRetryAttempt = 0;
    if (watcherRestartTimer) {
      clearTimeout(watcherRestartTimer);
      watcherRestartTimer = null;
    }

    configWatcher.on('error', (err) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[runtime-config] watcher error: ${reason}`);
      configWatcher?.close();
      configWatcher = null;
      scheduleWatcherRestart(`watcher error: ${reason}`);
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[runtime-config] watcher setup failed: ${reason}`);
    scheduleWatcherRestart(`watcher setup failed: ${reason}`);
  }
}

function ensureInitialConfigFile(): void {
  if (fs.existsSync(CONFIG_PATH)) return;
  const seeded = normalizeRuntimeConfig();
  writeConfigFile(seeded, { omitImplicitSandboxMode: true });
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

  try {
    const parsedRecord = parsed as Record<string, unknown>;
    const rawContainer = isRecord(parsedRecord.container)
      ? parsedRecord.container
      : {};
    const changed = writeConfigFile(migrated, {
      omitImplicitSandboxMode: !hasOwn(rawContainer, 'sandboxMode'),
    });
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

export function getRuntimeConfig(): RuntimeConfig {
  return cloneConfig(currentConfig);
}

export function isContainerSandboxModeExplicit(): boolean {
  return currentConfigMetadata.containerSandboxModeExplicit;
}

export function onRuntimeConfigChange(
  listener: RuntimeConfigChangeListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function saveRuntimeConfig(next: RuntimeConfig): RuntimeConfig {
  const normalized = normalizeRuntimeConfig(next);
  const sandboxModeExplicit =
    currentConfigMetadata.containerSandboxModeExplicit ||
    normalized.container.sandboxMode !==
      DEFAULT_RUNTIME_CONFIG.container.sandboxMode;
  currentConfigMetadata = {
    containerSandboxModeExplicit: sandboxModeExplicit,
  };
  writeConfigFile(normalized, {
    omitImplicitSandboxMode: !sandboxModeExplicit,
  });
  applyConfig(normalized);
  return cloneConfig(normalized);
}

export function updateRuntimeConfig(
  mutator: (draft: RuntimeConfig) => void,
): RuntimeConfig {
  let baseConfig = currentConfig;
  try {
    baseConfig = loadRuntimeConfigFromSources();
  } catch (err) {
    console.warn(
      `[runtime-config] update using in-memory config after reload failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const draft = cloneConfig(baseConfig);
  mutator(draft);
  return saveRuntimeConfig(draft);
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
