import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadEnvFile } from './env.js';
import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  onRuntimeConfigChange,
  type RuntimeConfig,
} from './runtime-config.js';

loadEnvFile();
ensureRuntimeConfigFile();

export class MissingRequiredEnvVarError extends Error {
  constructor(public readonly envVar: string) {
    super(`Missing required env var: ${envVar}`);
    this.name = 'MissingRequiredEnvVarError';
  }
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new MissingRequiredEnvVarError(name);
  return val;
}

function resolveAppVersion(): string {
  const envVersion = process.env.npm_package_version;
  if (envVersion) return envVersion;

  const packagePath = path.join(process.cwd(), 'package.json');
  try {
    const raw = fs.readFileSync(packagePath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // fall through
  }

  return '0.0.0';
}

export const APP_VERSION = resolveAppVersion();

// Secrets stay in env/.env
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
export const HYBRIDAI_API_KEY = required('HYBRIDAI_API_KEY');

// Runtime settings hot-reload from config.json
export let DISCORD_PREFIX = '!claw';

export let HYBRIDAI_BASE_URL = 'https://hybridai.one';
export let HYBRIDAI_MODEL = 'gpt-5-nano';
export let HYBRIDAI_CHATBOT_ID = '';
export let HYBRIDAI_ENABLE_RAG = true;
export let HYBRIDAI_MODELS: string[] = ['gpt-5-nano', 'gpt-5-mini', 'gpt-5'];

export let CONTAINER_IMAGE = 'hybridclaw-agent';
export let CONTAINER_MEMORY = '512m';
export let CONTAINER_CPUS = '1';
export let CONTAINER_TIMEOUT = 60_000;

export const MOUNT_ALLOWLIST_PATH = path.join(
  os.homedir(), '.config', 'hybridclaw', 'mount-allowlist.json',
);
export let ADDITIONAL_MOUNTS = '';

export let CONTAINER_MAX_OUTPUT_SIZE = 10_485_760;
export let MAX_CONCURRENT_CONTAINERS = 5;

export let HEARTBEAT_ENABLED = true;
export let HEARTBEAT_INTERVAL = 1_800_000;
export let HEARTBEAT_CHANNEL = '';

export let HEALTH_HOST = '127.0.0.1';
export let HEALTH_PORT = 9090;
export let WEB_API_TOKEN = '';
export let GATEWAY_BASE_URL = 'http://127.0.0.1:9090';
export let GATEWAY_API_TOKEN = '';
export let DB_PATH = 'data/hybridclaw.db';
export let DATA_DIR = path.dirname(DB_PATH);

export let SESSION_COMPACTION_ENABLED = true;
export let SESSION_COMPACTION_THRESHOLD = 120;
export let SESSION_COMPACTION_KEEP_RECENT = 40;
export let SESSION_COMPACTION_SUMMARY_MAX_CHARS = 8_000;
export let PRE_COMPACTION_MEMORY_FLUSH_ENABLED = true;
export let PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES = 80;
export let PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS = 24_000;

function applyRuntimeConfig(config: RuntimeConfig): void {
  DISCORD_PREFIX = config.discord.prefix;

  HYBRIDAI_BASE_URL = config.hybridai.baseUrl;
  HYBRIDAI_MODEL = config.hybridai.defaultModel;
  HYBRIDAI_CHATBOT_ID = config.hybridai.defaultChatbotId;
  HYBRIDAI_ENABLE_RAG = config.hybridai.enableRag;
  HYBRIDAI_MODELS = [...config.hybridai.models];

  CONTAINER_IMAGE = config.container.image;
  CONTAINER_MEMORY = config.container.memory;
  CONTAINER_CPUS = config.container.cpus;
  CONTAINER_TIMEOUT = config.container.timeoutMs;
  ADDITIONAL_MOUNTS = config.container.additionalMounts;
  CONTAINER_MAX_OUTPUT_SIZE = config.container.maxOutputBytes;
  MAX_CONCURRENT_CONTAINERS = Math.max(1, config.container.maxConcurrent);

  HEARTBEAT_ENABLED = config.heartbeat.enabled;
  HEARTBEAT_INTERVAL = config.heartbeat.intervalMs;
  HEARTBEAT_CHANNEL = config.heartbeat.channel;

  HEALTH_HOST = config.ops.healthHost;
  HEALTH_PORT = config.ops.healthPort;
  WEB_API_TOKEN = process.env.WEB_API_TOKEN || config.ops.webApiToken;
  GATEWAY_BASE_URL = config.ops.gatewayBaseUrl;
  GATEWAY_API_TOKEN = process.env.GATEWAY_API_TOKEN || config.ops.gatewayApiToken || WEB_API_TOKEN;
  DB_PATH = config.ops.dbPath;
  DATA_DIR = path.dirname(DB_PATH);

  SESSION_COMPACTION_ENABLED = config.sessionCompaction.enabled;
  SESSION_COMPACTION_THRESHOLD = Math.max(20, config.sessionCompaction.threshold);
  SESSION_COMPACTION_KEEP_RECENT = Math.max(
    1,
    Math.min(config.sessionCompaction.keepRecent, SESSION_COMPACTION_THRESHOLD - 1),
  );
  SESSION_COMPACTION_SUMMARY_MAX_CHARS = Math.max(1_000, config.sessionCompaction.summaryMaxChars);
  PRE_COMPACTION_MEMORY_FLUSH_ENABLED = config.sessionCompaction.preCompactionMemoryFlush.enabled;
  PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES = Math.max(8, config.sessionCompaction.preCompactionMemoryFlush.maxMessages);
  PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS = Math.max(4_000, config.sessionCompaction.preCompactionMemoryFlush.maxChars);
}

applyRuntimeConfig(getRuntimeConfig());
onRuntimeConfigChange((next) => {
  applyRuntimeConfig(next);
});

export { onRuntimeConfigChange as onConfigChange };
export function getConfigSnapshot(): RuntimeConfig {
  return getRuntimeConfig();
}
