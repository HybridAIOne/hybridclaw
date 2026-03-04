import fs from 'fs';
import path from 'path';

export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_VERSION = 3;
export const SECURITY_POLICY_VERSION = '2026-02-28';

const KNOWN_LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

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
export type DiscordChannelMode = 'off' | 'mention' | 'free';

export interface RuntimeDiscordGuildConfig {
  defaultMode: DiscordChannelMode;
  channels: Record<string, { mode: DiscordChannelMode }>;
}

export interface RuntimeConfig {
  version: number;
  security: RuntimeSecurityConfig;
  skills: {
    extraDirs: string[];
  };
  discord: {
    prefix: string;
    guildMembersIntent: boolean;
    presenceIntent: boolean;
    respondToAllMessages: boolean;
    commandsOnly: boolean;
    commandUserId: string;
    groupPolicy: DiscordGroupPolicy;
    freeResponseChannels: string[];
    guilds: Record<string, RuntimeDiscordGuildConfig>;
  };
  hybridai: {
    baseUrl: string;
    defaultModel: string;
    defaultChatbotId: string;
    enableRag: boolean;
    models: string[];
  };
  container: {
    image: string;
    memory: string;
    cpus: string;
    timeoutMs: number;
    additionalMounts: string;
    maxOutputBytes: number;
    maxConcurrent: number;
  };
  heartbeat: {
    enabled: boolean;
    intervalMs: number;
    channel: string;
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
}

export type RuntimeConfigChangeListener = (next: RuntimeConfig, prev: RuntimeConfig) => void;

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
  },
  discord: {
    prefix: '!claw',
    guildMembersIntent: false,
    presenceIntent: false,
    respondToAllMessages: false,
    commandsOnly: false,
    commandUserId: '',
    groupPolicy: 'open',
    freeResponseChannels: [],
    guilds: {},
  },
  hybridai: {
    baseUrl: 'https://hybridai.one',
    defaultModel: 'gpt-5-nano',
    defaultChatbotId: '',
    enableRag: true,
    models: ['gpt-5-nano', 'gpt-5-mini', 'gpt-5'],
  },
  container: {
    image: 'hybridclaw-agent',
    memory: '512m',
    cpus: '1',
    timeoutMs: 300_000,
    additionalMounts: '',
    maxOutputBytes: 10_485_760,
    maxConcurrent: 5,
  },
  heartbeat: {
    enabled: true,
    intervalMs: 1_800_000,
    channel: '',
  },
  ops: {
    healthHost: '127.0.0.1',
    healthPort: 9090,
    webApiToken: '',
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    gatewayApiToken: '',
    dbPath: 'data/hybridclaw.db',
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
    threshold: 120,
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
};

const CONFIG_PATH = path.join(process.cwd(), CONFIG_FILE_NAME);

let currentConfig: RuntimeConfig = cloneConfig(DEFAULT_RUNTIME_CONFIG);
let configWatcher: fs.FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<RuntimeConfigChangeListener>();
const WATCHER_RETRY_BASE_DELAY_MS = 1_000;
const WATCHER_RETRY_MAX_DELAY_MS = 60_000;
const WATCHER_RETRY_MAX_ATTEMPTS = 10;
let watcherRetryAttempt = 0;
let watcherRestartTimer: ReturnType<typeof setTimeout> | null = null;

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

function normalizeDiscordGroupPolicy(value: unknown, fallback: DiscordGroupPolicy): DiscordGroupPolicy {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'open' || normalized === 'allowlist' || normalized === 'disabled') {
    return normalized;
  }
  return fallback;
}

function normalizeDiscordChannelMode(value: unknown, fallback: DiscordChannelMode): DiscordChannelMode {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'mention' || normalized === 'free') return normalized;
  if (normalized === 'free-response' || normalized === 'free_response') return 'free';
  return fallback;
}

function normalizeDiscordGuildConfig(
  value: unknown,
  fallback: RuntimeDiscordGuildConfig,
): RuntimeDiscordGuildConfig {
  if (!isRecord(value)) return fallback;
  const defaultMode = normalizeDiscordChannelMode(value.defaultMode, fallback.defaultMode);
  const rawChannels = isRecord(value.channels) ? value.channels : {};
  const channels: Record<string, { mode: DiscordChannelMode }> = {};
  for (const [rawChannelId, rawChannelConfig] of Object.entries(rawChannels)) {
    const channelId = rawChannelId.trim();
    if (!channelId) continue;
    if (typeof rawChannelConfig === 'string') {
      channels[channelId] = { mode: normalizeDiscordChannelMode(rawChannelConfig, defaultMode) };
      continue;
    }
    if (!isRecord(rawChannelConfig)) continue;
    channels[channelId] = { mode: normalizeDiscordChannelMode(rawChannelConfig.mode, defaultMode) };
  }

  return { defaultMode, channels };
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
    const fallbackGuild = fallback[guildId] ?? { defaultMode: 'mention', channels: {} };
    guilds[guildId] = normalizeDiscordGuildConfig(rawGuildConfig, fallbackGuild);
  }
  return guilds;
}

function normalizeLogLevel(value: unknown, fallback: LogLevel): LogLevel {
  const normalized = normalizeString(value, fallback, { allowEmpty: false }).toLowerCase();
  if (KNOWN_LOG_LEVELS.has(normalized)) return normalized as LogLevel;
  return fallback;
}

function normalizeBaseUrl(value: unknown, fallback: string): string {
  const candidate = normalizeString(value, fallback, { allowEmpty: false });
  return candidate.replace(/\/+$/, '') || fallback;
}

function normalizeApiPath(value: unknown, fallback: string): string {
  const normalized = normalizeString(value, fallback, { allowEmpty: false, trim: true });
  if (/^https?:\/\//i.test(normalized)) {
    return normalized.replace(/\/+$/, '');
  }
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return prefixed.replace(/\/{2,}/g, '/');
}

function parseConfigPatch(payload: unknown): DeepPartial<RuntimeConfig> {
  if (!isRecord(payload)) {
    throw new Error('config.json must contain a top-level object');
  }
  return payload as DeepPartial<RuntimeConfig>;
}

function normalizeRuntimeConfig(patch?: DeepPartial<RuntimeConfig>): RuntimeConfig {
  const raw = patch ?? {};

  const rawSecurity = isRecord(raw.security) ? raw.security : {};
  const rawSkills = isRecord(raw.skills) ? raw.skills : {};
  const rawDiscord = isRecord(raw.discord) ? raw.discord : {};
  const rawHybridAi = isRecord(raw.hybridai) ? raw.hybridai : {};
  const rawContainer = isRecord(raw.container) ? raw.container : {};
  const rawHeartbeat = isRecord(raw.heartbeat) ? raw.heartbeat : {};
  const rawOps = isRecord(raw.ops) ? raw.ops : {};
  const rawObservability = isRecord(raw.observability) ? raw.observability : {};
  const rawSessionCompaction = isRecord(raw.sessionCompaction) ? raw.sessionCompaction : {};
  const rawPreFlush = isRecord(rawSessionCompaction.preCompactionMemoryFlush)
    ? rawSessionCompaction.preCompactionMemoryFlush
    : {};
  const rawPromptHooks = isRecord(raw.promptHooks) ? raw.promptHooks : {};
  const rawProactive = isRecord(raw.proactive) ? raw.proactive : {};
  const rawActiveHours = isRecord(rawProactive.activeHours) ? rawProactive.activeHours : {};
  const rawDelegation = isRecord(rawProactive.delegation) ? rawProactive.delegation : {};
  const rawAutoRetry = isRecord(rawProactive.autoRetry) ? rawProactive.autoRetry : {};
  const rawRalph = isRecord(rawProactive.ralph) ? rawProactive.ralph : {};

  const defaultOps = DEFAULT_RUNTIME_CONFIG.ops;
  const healthPort = normalizeInteger(rawOps.healthPort, defaultOps.healthPort, { min: 1, max: 65_535 });
  const webApiToken = normalizeString(rawOps.webApiToken, defaultOps.webApiToken, { allowEmpty: true });
  const hybridBaseUrl = normalizeBaseUrl(rawHybridAi.baseUrl, DEFAULT_RUNTIME_CONFIG.hybridai.baseUrl);
  const hybridDefaultChatbotId = normalizeString(
    rawHybridAi.defaultChatbotId,
    DEFAULT_RUNTIME_CONFIG.hybridai.defaultChatbotId,
    { allowEmpty: true },
  );

  const threshold = normalizeInteger(
    rawSessionCompaction.threshold,
    DEFAULT_RUNTIME_CONFIG.sessionCompaction.threshold,
    { min: 20 },
  );
  const keepRecentRaw = normalizeInteger(
    rawSessionCompaction.keepRecent,
    DEFAULT_RUNTIME_CONFIG.sessionCompaction.keepRecent,
    { min: 1 },
  );
  const keepRecent = Math.min(keepRecentRaw, Math.max(1, threshold - 1));

  const modelList = normalizeStringArray(rawHybridAi.models, DEFAULT_RUNTIME_CONFIG.hybridai.models);

  return {
    version: CONFIG_VERSION,
    security: {
      trustModelAccepted: normalizeBoolean(rawSecurity.trustModelAccepted, DEFAULT_RUNTIME_CONFIG.security.trustModelAccepted),
      trustModelAcceptedAt: normalizeString(rawSecurity.trustModelAcceptedAt, DEFAULT_RUNTIME_CONFIG.security.trustModelAcceptedAt, { allowEmpty: true }),
      trustModelVersion: normalizeString(rawSecurity.trustModelVersion, DEFAULT_RUNTIME_CONFIG.security.trustModelVersion, { allowEmpty: true }),
      trustModelAcceptedBy: normalizeString(rawSecurity.trustModelAcceptedBy, DEFAULT_RUNTIME_CONFIG.security.trustModelAcceptedBy, { allowEmpty: true }),
    },
    skills: {
      extraDirs: normalizeStringArray(rawSkills.extraDirs, DEFAULT_RUNTIME_CONFIG.skills.extraDirs),
    },
    discord: {
      prefix: normalizeString(rawDiscord.prefix, DEFAULT_RUNTIME_CONFIG.discord.prefix, { allowEmpty: false }),
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
      commandUserId: normalizeString(
        rawDiscord.commandUserId,
        DEFAULT_RUNTIME_CONFIG.discord.commandUserId,
        { allowEmpty: true },
      ),
      groupPolicy: normalizeDiscordGroupPolicy(
        rawDiscord.groupPolicy,
        DEFAULT_RUNTIME_CONFIG.discord.groupPolicy,
      ),
      freeResponseChannels: normalizeStringArray(
        rawDiscord.freeResponseChannels,
        DEFAULT_RUNTIME_CONFIG.discord.freeResponseChannels,
      ),
      guilds: normalizeDiscordGuildMap(rawDiscord.guilds, DEFAULT_RUNTIME_CONFIG.discord.guilds),
    },
    hybridai: {
      baseUrl: hybridBaseUrl,
      defaultModel: normalizeString(rawHybridAi.defaultModel, DEFAULT_RUNTIME_CONFIG.hybridai.defaultModel, { allowEmpty: false }),
      defaultChatbotId: hybridDefaultChatbotId,
      enableRag: normalizeBoolean(rawHybridAi.enableRag, DEFAULT_RUNTIME_CONFIG.hybridai.enableRag),
      models: modelList,
    },
    container: {
      image: normalizeString(rawContainer.image, DEFAULT_RUNTIME_CONFIG.container.image, { allowEmpty: false }),
      memory: normalizeString(rawContainer.memory, DEFAULT_RUNTIME_CONFIG.container.memory, { allowEmpty: false }),
      cpus: normalizeString(rawContainer.cpus, DEFAULT_RUNTIME_CONFIG.container.cpus, { allowEmpty: false }),
      timeoutMs: normalizeInteger(rawContainer.timeoutMs, DEFAULT_RUNTIME_CONFIG.container.timeoutMs, { min: 1_000 }),
      additionalMounts: normalizeString(rawContainer.additionalMounts, DEFAULT_RUNTIME_CONFIG.container.additionalMounts, { allowEmpty: true }),
      maxOutputBytes: normalizeInteger(rawContainer.maxOutputBytes, DEFAULT_RUNTIME_CONFIG.container.maxOutputBytes, { min: 1_024 }),
      maxConcurrent: normalizeInteger(rawContainer.maxConcurrent, DEFAULT_RUNTIME_CONFIG.container.maxConcurrent, { min: 1 }),
    },
    heartbeat: {
      enabled: normalizeBoolean(rawHeartbeat.enabled, DEFAULT_RUNTIME_CONFIG.heartbeat.enabled),
      intervalMs: normalizeInteger(rawHeartbeat.intervalMs, DEFAULT_RUNTIME_CONFIG.heartbeat.intervalMs, { min: 10_000 }),
      channel: normalizeString(rawHeartbeat.channel, DEFAULT_RUNTIME_CONFIG.heartbeat.channel, { allowEmpty: true }),
    },
    ops: {
      healthHost: normalizeString(rawOps.healthHost, defaultOps.healthHost, { allowEmpty: false }),
      healthPort,
      webApiToken,
      gatewayBaseUrl: normalizeBaseUrl(rawOps.gatewayBaseUrl, `http://127.0.0.1:${healthPort}`),
      gatewayApiToken: normalizeString(rawOps.gatewayApiToken, webApiToken, { allowEmpty: true }),
      dbPath: normalizeString(rawOps.dbPath, defaultOps.dbPath, { allowEmpty: false }),
      logLevel: normalizeLogLevel(rawOps.logLevel, defaultOps.logLevel),
    },
    observability: {
      enabled: normalizeBoolean(rawObservability.enabled, DEFAULT_RUNTIME_CONFIG.observability.enabled),
      baseUrl: normalizeBaseUrl(rawObservability.baseUrl, hybridBaseUrl),
      ingestPath: normalizeApiPath(rawObservability.ingestPath, DEFAULT_RUNTIME_CONFIG.observability.ingestPath),
      statusPath: normalizeApiPath(rawObservability.statusPath, DEFAULT_RUNTIME_CONFIG.observability.statusPath),
      botId: normalizeString(rawObservability.botId, hybridDefaultChatbotId, { allowEmpty: true }),
      agentId: normalizeString(rawObservability.agentId, DEFAULT_RUNTIME_CONFIG.observability.agentId, { allowEmpty: false }),
      label: normalizeString(rawObservability.label, DEFAULT_RUNTIME_CONFIG.observability.label, { allowEmpty: true }),
      environment: normalizeString(rawObservability.environment, DEFAULT_RUNTIME_CONFIG.observability.environment, { allowEmpty: false }),
      flushIntervalMs: normalizeInteger(rawObservability.flushIntervalMs, DEFAULT_RUNTIME_CONFIG.observability.flushIntervalMs, { min: 1_000, max: 3_600_000 }),
      batchMaxEvents: normalizeInteger(rawObservability.batchMaxEvents, DEFAULT_RUNTIME_CONFIG.observability.batchMaxEvents, { min: 1, max: 1_000 }),
    },
    sessionCompaction: {
      enabled: normalizeBoolean(rawSessionCompaction.enabled, DEFAULT_RUNTIME_CONFIG.sessionCompaction.enabled),
      threshold,
      keepRecent,
      summaryMaxChars: normalizeInteger(
        rawSessionCompaction.summaryMaxChars,
        DEFAULT_RUNTIME_CONFIG.sessionCompaction.summaryMaxChars,
        { min: 1_000 },
      ),
      preCompactionMemoryFlush: {
        enabled: normalizeBoolean(rawPreFlush.enabled, DEFAULT_RUNTIME_CONFIG.sessionCompaction.preCompactionMemoryFlush.enabled),
        maxMessages: normalizeInteger(
          rawPreFlush.maxMessages,
          DEFAULT_RUNTIME_CONFIG.sessionCompaction.preCompactionMemoryFlush.maxMessages,
          { min: 8 },
        ),
        maxChars: normalizeInteger(
          rawPreFlush.maxChars,
          DEFAULT_RUNTIME_CONFIG.sessionCompaction.preCompactionMemoryFlush.maxChars,
          { min: 4_000 },
        ),
      },
    },
    promptHooks: {
      bootstrapEnabled: normalizeBoolean(rawPromptHooks.bootstrapEnabled, DEFAULT_RUNTIME_CONFIG.promptHooks.bootstrapEnabled),
      memoryEnabled: normalizeBoolean(rawPromptHooks.memoryEnabled, DEFAULT_RUNTIME_CONFIG.promptHooks.memoryEnabled),
      safetyEnabled: normalizeBoolean(rawPromptHooks.safetyEnabled, DEFAULT_RUNTIME_CONFIG.promptHooks.safetyEnabled),
      proactivityEnabled: normalizeBoolean(rawPromptHooks.proactivityEnabled, DEFAULT_RUNTIME_CONFIG.promptHooks.proactivityEnabled),
    },
    proactive: {
      activeHours: {
        enabled: normalizeBoolean(rawActiveHours.enabled, DEFAULT_RUNTIME_CONFIG.proactive.activeHours.enabled),
        timezone: normalizeString(rawActiveHours.timezone, DEFAULT_RUNTIME_CONFIG.proactive.activeHours.timezone, { allowEmpty: true }),
        startHour: normalizeInteger(rawActiveHours.startHour, DEFAULT_RUNTIME_CONFIG.proactive.activeHours.startHour, { min: 0, max: 23 }),
        endHour: normalizeInteger(rawActiveHours.endHour, DEFAULT_RUNTIME_CONFIG.proactive.activeHours.endHour, { min: 0, max: 23 }),
        queueOutsideHours: normalizeBoolean(rawActiveHours.queueOutsideHours, DEFAULT_RUNTIME_CONFIG.proactive.activeHours.queueOutsideHours),
      },
      delegation: {
        enabled: normalizeBoolean(rawDelegation.enabled, DEFAULT_RUNTIME_CONFIG.proactive.delegation.enabled),
        maxConcurrent: normalizeInteger(rawDelegation.maxConcurrent, DEFAULT_RUNTIME_CONFIG.proactive.delegation.maxConcurrent, { min: 1, max: 8 }),
        maxDepth: normalizeInteger(rawDelegation.maxDepth, DEFAULT_RUNTIME_CONFIG.proactive.delegation.maxDepth, { min: 1, max: 4 }),
        maxPerTurn: normalizeInteger(rawDelegation.maxPerTurn, DEFAULT_RUNTIME_CONFIG.proactive.delegation.maxPerTurn, { min: 1, max: 8 }),
      },
      autoRetry: {
        enabled: normalizeBoolean(rawAutoRetry.enabled, DEFAULT_RUNTIME_CONFIG.proactive.autoRetry.enabled),
        maxAttempts: normalizeInteger(rawAutoRetry.maxAttempts, DEFAULT_RUNTIME_CONFIG.proactive.autoRetry.maxAttempts, { min: 1, max: 8 }),
        baseDelayMs: normalizeInteger(rawAutoRetry.baseDelayMs, DEFAULT_RUNTIME_CONFIG.proactive.autoRetry.baseDelayMs, { min: 100, max: 120_000 }),
        maxDelayMs: normalizeInteger(rawAutoRetry.maxDelayMs, DEFAULT_RUNTIME_CONFIG.proactive.autoRetry.maxDelayMs, { min: 100, max: 600_000 }),
      },
      ralph: {
        maxIterations: normalizeInteger(rawRalph.maxIterations, DEFAULT_RUNTIME_CONFIG.proactive.ralph.maxIterations, { min: -1, max: 64 }),
      },
    },
  };
}

function loadConfigPatchFromDisk(): DeepPartial<RuntimeConfig> {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return parseConfigPatch(parsed);
}

function writeConfigFile(config: RuntimeConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const nextText = `${JSON.stringify(config, null, 2)}\n`;
  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, nextText, 'utf-8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

function applyConfig(next: RuntimeConfig): void {
  const prev = currentConfig;
  currentConfig = cloneConfig(next);

  if (JSON.stringify(prev) === JSON.stringify(currentConfig)) return;
  for (const listener of listeners) {
    try {
      listener(cloneConfig(currentConfig), cloneConfig(prev));
    } catch (err) {
      console.warn(`[runtime-config] listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function loadRuntimeConfigFromSources(): RuntimeConfig {
  const diskPatch = loadConfigPatchFromDisk();
  return normalizeRuntimeConfig(diskPatch);
}

function reloadFromDisk(trigger: string): void {
  try {
    const next = loadRuntimeConfigFromSources();
    applyConfig(next);
  } catch (err) {
    console.warn(`[runtime-config] reload failed (${trigger}): ${err instanceof Error ? err.message : String(err)}`);
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
  if (watcherRestartTimer) return;
  if (watcherRetryAttempt >= WATCHER_RETRY_MAX_ATTEMPTS) {
    console.warn(`[runtime-config] watcher disabled after ${WATCHER_RETRY_MAX_ATTEMPTS} retries (${reason})`);
    return;
  }

  watcherRetryAttempt += 1;
  const delay = Math.min(
    WATCHER_RETRY_BASE_DELAY_MS * (2 ** (watcherRetryAttempt - 1)),
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
  if (configWatcher) return;

  try {
    configWatcher = fs.watch(path.dirname(CONFIG_PATH), { persistent: false }, (_event, filename) => {
      if (!filename) {
        scheduleReload('unknown');
        return;
      }
      if (filename.toString() !== path.basename(CONFIG_PATH)) return;
      scheduleReload(`watch:${filename.toString()}`);
    });
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
  writeConfigFile(seeded);
}

function migrateConfigSchemaOnStartup(): void {
  if (!fs.existsSync(CONFIG_PATH)) return;

  let raw: string;
  let parsed: unknown;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    console.warn(`[runtime-config] schema migration skipped (invalid JSON): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!isRecord(parsed)) {
    console.warn('[runtime-config] schema migration skipped: config.json is not an object');
    return;
  }

  const previousVersion = typeof parsed.version === 'number' ? parsed.version : null;
  let migrated: RuntimeConfig;
  try {
    migrated = normalizeRuntimeConfig(parseConfigPatch(parsed));
  } catch (err) {
    console.warn(`[runtime-config] schema migration skipped: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Canonical semantic comparison (ignoring formatting/whitespace)
  if (JSON.stringify(parsed) === JSON.stringify(migrated)) return;

  try {
    writeConfigFile(migrated);
    const from = previousVersion == null ? 'unknown' : String(previousVersion);
    if (previousVersion !== CONFIG_VERSION) {
      console.info(`[runtime-config] migrated config schema from v${from} to v${CONFIG_VERSION}`);
    } else {
      console.info(`[runtime-config] normalized config schema v${CONFIG_VERSION} (filled defaults/canonicalized values)`);
    }
  } catch (err) {
    console.warn(`[runtime-config] schema migration failed: ${err instanceof Error ? err.message : String(err)}`);
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

export function onRuntimeConfigChange(listener: RuntimeConfigChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function saveRuntimeConfig(next: RuntimeConfig): RuntimeConfig {
  const normalized = normalizeRuntimeConfig(next);
  writeConfigFile(normalized);
  applyConfig(normalized);
  return cloneConfig(normalized);
}

export function updateRuntimeConfig(mutator: (draft: RuntimeConfig) => void): RuntimeConfig {
  const draft = cloneConfig(currentConfig);
  mutator(draft);
  return saveRuntimeConfig(draft);
}

export function isSecurityTrustAccepted(config: RuntimeConfig = currentConfig): boolean {
  return Boolean(
    config.security.trustModelAccepted
    && config.security.trustModelAcceptedAt
    && config.security.trustModelVersion === SECURITY_POLICY_VERSION,
  );
}

export function acceptSecurityTrustModel(params?: {
  acceptedAt?: string;
  acceptedBy?: string | null;
  policyVersion?: string;
}): RuntimeConfig {
  const acceptedAt = normalizeString(params?.acceptedAt, new Date().toISOString(), { allowEmpty: false });
  const acceptedBy = normalizeString(params?.acceptedBy ?? '', '', { allowEmpty: true });
  const policyVersion = normalizeString(params?.policyVersion, SECURITY_POLICY_VERSION, { allowEmpty: false });

  return updateRuntimeConfig((draft) => {
    draft.security.trustModelAccepted = true;
    draft.security.trustModelAcceptedAt = acceptedAt;
    draft.security.trustModelAcceptedBy = acceptedBy;
    draft.security.trustModelVersion = policyVersion;
  });
}
