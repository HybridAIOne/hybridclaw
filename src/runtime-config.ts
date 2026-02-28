import fs from 'fs';
import path from 'path';

import { loadEnvFile } from './env.js';

loadEnvFile();

export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_VERSION = 1;
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

export interface RuntimeConfig {
  version: number;
  security: RuntimeSecurityConfig;
  discord: {
    prefix: string;
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
  discord: {
    prefix: '!claw',
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
    timeoutMs: 60_000,
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
  },
};

const CONFIG_PATH = path.join(process.cwd(), CONFIG_FILE_NAME);

let currentConfig: RuntimeConfig = cloneConfig(DEFAULT_RUNTIME_CONFIG);
let configWatcher: fs.FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<RuntimeConfigChangeListener>();

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

function normalizeLogLevel(value: unknown, fallback: LogLevel): LogLevel {
  const normalized = normalizeString(value, fallback, { allowEmpty: false }).toLowerCase();
  if (KNOWN_LOG_LEVELS.has(normalized)) return normalized as LogLevel;
  return fallback;
}

function normalizeBaseUrl(value: unknown, fallback: string): string {
  const candidate = normalizeString(value, fallback, { allowEmpty: false });
  return candidate.replace(/\/+$/, '') || fallback;
}

function parseConfigPatch(payload: unknown): DeepPartial<RuntimeConfig> {
  if (!isRecord(payload)) {
    throw new Error('config.json must contain a top-level object');
  }
  return payload as DeepPartial<RuntimeConfig>;
}

function readLegacyEnvPatch(): DeepPartial<RuntimeConfig> {
  const env = process.env;

  const patch: Record<string, unknown> = {
    discord: {},
    hybridai: {},
    container: {},
    heartbeat: {},
    ops: {},
    sessionCompaction: {
      preCompactionMemoryFlush: {},
    },
    promptHooks: {},
  };

  const discord = patch.discord as Record<string, unknown>;
  const hybridai = patch.hybridai as Record<string, unknown>;
  const container = patch.container as Record<string, unknown>;
  const heartbeat = patch.heartbeat as Record<string, unknown>;
  const ops = patch.ops as Record<string, unknown>;
  const sessionCompaction = patch.sessionCompaction as Record<string, unknown>;
  const preCompactionMemoryFlush = sessionCompaction.preCompactionMemoryFlush as Record<string, unknown>;

  if (env.DISCORD_PREFIX != null) discord.prefix = env.DISCORD_PREFIX;

  if (env.HYBRIDAI_BASE_URL != null) hybridai.baseUrl = env.HYBRIDAI_BASE_URL;
  if (env.HYBRIDAI_MODEL != null) hybridai.defaultModel = env.HYBRIDAI_MODEL;
  if (env.HYBRIDAI_CHATBOT_ID != null) hybridai.defaultChatbotId = env.HYBRIDAI_CHATBOT_ID;
  if (env.HYBRIDAI_ENABLE_RAG != null) hybridai.enableRag = env.HYBRIDAI_ENABLE_RAG;
  if (env.HYBRIDAI_MODELS != null) hybridai.models = env.HYBRIDAI_MODELS;

  if (env.CONTAINER_IMAGE != null) container.image = env.CONTAINER_IMAGE;
  if (env.CONTAINER_MEMORY != null) container.memory = env.CONTAINER_MEMORY;
  if (env.CONTAINER_CPUS != null) container.cpus = env.CONTAINER_CPUS;
  if (env.CONTAINER_TIMEOUT != null) container.timeoutMs = env.CONTAINER_TIMEOUT;
  if (env.ADDITIONAL_MOUNTS != null) container.additionalMounts = env.ADDITIONAL_MOUNTS;
  if (env.CONTAINER_MAX_OUTPUT_SIZE != null) container.maxOutputBytes = env.CONTAINER_MAX_OUTPUT_SIZE;
  if (env.MAX_CONCURRENT_CONTAINERS != null) container.maxConcurrent = env.MAX_CONCURRENT_CONTAINERS;

  if (env.HEARTBEAT_ENABLED != null) heartbeat.enabled = env.HEARTBEAT_ENABLED;
  if (env.HEARTBEAT_INTERVAL != null) heartbeat.intervalMs = env.HEARTBEAT_INTERVAL;
  if (env.HEARTBEAT_CHANNEL != null) heartbeat.channel = env.HEARTBEAT_CHANNEL;

  if (env.HEALTH_HOST != null) ops.healthHost = env.HEALTH_HOST;
  if (env.HEALTH_PORT != null) ops.healthPort = env.HEALTH_PORT;
  if (env.GATEWAY_BASE_URL != null) ops.gatewayBaseUrl = env.GATEWAY_BASE_URL;
  if (env.DB_PATH != null) ops.dbPath = env.DB_PATH;
  if (env.LOG_LEVEL != null) ops.logLevel = env.LOG_LEVEL;

  if (env.SESSION_COMPACTION_ENABLED != null) sessionCompaction.enabled = env.SESSION_COMPACTION_ENABLED;
  if (env.SESSION_COMPACTION_THRESHOLD != null) sessionCompaction.threshold = env.SESSION_COMPACTION_THRESHOLD;
  if (env.SESSION_COMPACTION_KEEP_RECENT != null) sessionCompaction.keepRecent = env.SESSION_COMPACTION_KEEP_RECENT;
  if (env.SESSION_COMPACTION_SUMMARY_MAX_CHARS != null) sessionCompaction.summaryMaxChars = env.SESSION_COMPACTION_SUMMARY_MAX_CHARS;
  if (env.PRE_COMPACTION_MEMORY_FLUSH_ENABLED != null) {
    preCompactionMemoryFlush.enabled = env.PRE_COMPACTION_MEMORY_FLUSH_ENABLED;
  }
  if (env.PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES != null) {
    preCompactionMemoryFlush.maxMessages = env.PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES;
  }
  if (env.PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS != null) {
    preCompactionMemoryFlush.maxChars = env.PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS;
  }

  return patch as DeepPartial<RuntimeConfig>;
}

function normalizeRuntimeConfig(patch?: DeepPartial<RuntimeConfig>): RuntimeConfig {
  const raw = patch ?? {};

  const rawSecurity = isRecord(raw.security) ? raw.security : {};
  const rawDiscord = isRecord(raw.discord) ? raw.discord : {};
  const rawHybridAi = isRecord(raw.hybridai) ? raw.hybridai : {};
  const rawContainer = isRecord(raw.container) ? raw.container : {};
  const rawHeartbeat = isRecord(raw.heartbeat) ? raw.heartbeat : {};
  const rawOps = isRecord(raw.ops) ? raw.ops : {};
  const rawSessionCompaction = isRecord(raw.sessionCompaction) ? raw.sessionCompaction : {};
  const rawPreFlush = isRecord(rawSessionCompaction.preCompactionMemoryFlush)
    ? rawSessionCompaction.preCompactionMemoryFlush
    : {};
  const rawPromptHooks = isRecord(raw.promptHooks) ? raw.promptHooks : {};

  const defaultOps = DEFAULT_RUNTIME_CONFIG.ops;
  const healthPort = normalizeInteger(rawOps.healthPort, defaultOps.healthPort, { min: 1, max: 65_535 });
  const webApiToken = normalizeString(rawOps.webApiToken, defaultOps.webApiToken, { allowEmpty: true });

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
    discord: {
      prefix: normalizeString(rawDiscord.prefix, DEFAULT_RUNTIME_CONFIG.discord.prefix, { allowEmpty: false }),
    },
    hybridai: {
      baseUrl: normalizeBaseUrl(rawHybridAi.baseUrl, DEFAULT_RUNTIME_CONFIG.hybridai.baseUrl),
      defaultModel: normalizeString(rawHybridAi.defaultModel, DEFAULT_RUNTIME_CONFIG.hybridai.defaultModel, { allowEmpty: false }),
      defaultChatbotId: normalizeString(rawHybridAi.defaultChatbotId, DEFAULT_RUNTIME_CONFIG.hybridai.defaultChatbotId, { allowEmpty: true }),
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
    },
  };
}

function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      target[key] = [...value];
      continue;
    }
    if (isRecord(value)) {
      const existing = target[key];
      const nested = isRecord(existing) ? existing : {};
      mergePatch(nested, value);
      target[key] = nested;
      continue;
    }
    target[key] = value;
  }
}

function combinePatches(...patches: DeepPartial<RuntimeConfig>[]): DeepPartial<RuntimeConfig> {
  const merged: Record<string, unknown> = {};
  for (const patch of patches) {
    if (!isRecord(patch)) continue;
    mergePatch(merged, patch);
  }
  return merged as DeepPartial<RuntimeConfig>;
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
  const envPatch = readLegacyEnvPatch();
  const diskPatch = loadConfigPatchFromDisk();
  return normalizeRuntimeConfig(combinePatches(envPatch, diskPatch));
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

    configWatcher.on('error', (err) => {
      console.warn(`[runtime-config] watcher error: ${err instanceof Error ? err.message : String(err)}`);
      configWatcher?.close();
      configWatcher = null;
      setTimeout(startWatcher, 1_000);
    });
  } catch (err) {
    console.warn(`[runtime-config] watcher setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ensureInitialConfigFile(): void {
  if (fs.existsSync(CONFIG_PATH)) return;
  const seeded = normalizeRuntimeConfig(readLegacyEnvPatch());
  writeConfigFile(seeded);
}

function initializeRuntimeConfig(): void {
  ensureInitialConfigFile();
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
