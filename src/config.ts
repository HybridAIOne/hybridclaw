import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeSecrets } from './runtime-secrets.js';
import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  isContainerSandboxModeExplicit,
  onRuntimeConfigChange,
  type RuntimeConfig,
} from './runtime-config.js';

loadRuntimeSecrets();
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

function readVersionFromPackageJson(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // fall through
  }
  return null;
}

function resolveAppVersion(): string {
  const envVersion = process.env.npm_package_version;
  if (envVersion?.trim()) return envVersion.trim();

  const modulePath = fileURLToPath(import.meta.url);
  const moduleVersion = readVersionFromPackageJson(
    path.join(path.dirname(modulePath), '..', 'package.json'),
  );
  if (moduleVersion) return moduleVersion;

  const entryPath = process.argv[1];
  if (entryPath) {
    const entryVersion = readVersionFromPackageJson(
      path.join(path.dirname(path.resolve(entryPath)), '..', 'package.json'),
    );
    if (entryVersion) return entryVersion;
  }

  const cwdVersion = readVersionFromPackageJson(
    path.join(process.cwd(), 'package.json'),
  );
  if (cwdVersion) return cwdVersion;

  return '0.0.0';
}

export const APP_VERSION = resolveAppVersion();

function syncRuntimeSecretExports(): void {
  DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
  HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY || '';
}

// Secrets come from the shell environment or ~/.hybridclaw/credentials.json.
export let DISCORD_TOKEN = '';
// Keep module import side-effect free so CLI can guide onboarding/hints before hard-failing.
export let HYBRIDAI_API_KEY = '';
syncRuntimeSecretExports();

export function refreshRuntimeSecretsFromEnv(): void {
  syncRuntimeSecretExports();
}

export function getHybridAIApiKey(): string {
  return required('HYBRIDAI_API_KEY');
}

// Runtime settings hot-reload from ~/.hybridclaw/config.json by default
export let DISCORD_PREFIX = '!claw';
export let DISCORD_GUILD_MEMBERS_INTENT = false;
export let DISCORD_PRESENCE_INTENT = false;
export let DISCORD_RESPOND_TO_ALL_MESSAGES = false;
export let DISCORD_COMMANDS_ONLY = false;
export let DISCORD_COMMAND_MODE: RuntimeConfig['discord']['commandMode'] =
  'public';
export let DISCORD_COMMAND_ALLOWED_USER_IDS: string[] = [];
export let DISCORD_COMMAND_USER_ID = '';
export let DISCORD_GROUP_POLICY: RuntimeConfig['discord']['groupPolicy'] =
  'open';
export let DISCORD_SEND_POLICY: RuntimeConfig['discord']['sendPolicy'] = 'open';
export let DISCORD_SEND_ALLOWED_CHANNEL_IDS: string[] = [];
export let DISCORD_FREE_RESPONSE_CHANNELS: string[] = [];
export let DISCORD_TEXT_CHUNK_LIMIT = 2_000;
export let DISCORD_MAX_LINES_PER_MESSAGE = 17;
export let DISCORD_HUMAN_DELAY: RuntimeConfig['discord']['humanDelay'] = {
  mode: 'natural',
  minMs: 800,
  maxMs: 2_500,
};
export let DISCORD_TYPING_MODE: RuntimeConfig['discord']['typingMode'] =
  'thinking';
export let DISCORD_SELF_PRESENCE: RuntimeConfig['discord']['presence'] = {
  enabled: true,
  intervalMs: 30_000,
  healthyText: 'Watching the channels',
  degradedText: 'Thinking slowly...',
  exhaustedText: 'Taking a break',
  activityType: 'watching',
};
export let DISCORD_LIFECYCLE_REACTIONS: RuntimeConfig['discord']['lifecycleReactions'] =
  {
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
  };
export let DISCORD_ACK_REACTION = '👀';
export let DISCORD_ACK_REACTION_SCOPE: RuntimeConfig['discord']['ackReactionScope'] =
  'group-mentions';
export let DISCORD_REMOVE_ACK_AFTER_REPLY = true;
export let DISCORD_DEBOUNCE_MS = 2_500;
export let DISCORD_RATE_LIMIT_PER_USER = 0;
export let DISCORD_RATE_LIMIT_EXEMPT_ROLES: string[] = [];
export let DISCORD_SUPPRESS_PATTERNS: string[] = [
  '/stop',
  '/pause',
  'brb',
  'afk',
];
export let DISCORD_MAX_CONCURRENT_PER_CHANNEL = 2;
export let DISCORD_GUILDS: RuntimeConfig['discord']['guilds'] = {};

export let HYBRIDAI_BASE_URL = 'https://hybridai.one';
export let HYBRIDAI_MODEL = 'gpt-5-nano';
export let HYBRIDAI_CHATBOT_ID = '';
export let HYBRIDAI_MAX_TOKENS = 4_096;
export let HYBRIDAI_ENABLE_RAG = true;
export let HYBRIDAI_MODELS: string[] = ['gpt-5-nano', 'gpt-5-mini', 'gpt-5'];

export let CONTAINER_IMAGE = 'hybridclaw-agent';
export let CONTAINER_MEMORY = '512m';
export let CONTAINER_MEMORY_SWAP = '';
export let CONTAINER_CPUS = '1';
export let CONTAINER_NETWORK = 'bridge';
export let CONTAINER_TIMEOUT = 300_000;
export let CONTAINER_SANDBOX_MODE: RuntimeConfig['container']['sandboxMode'] =
  'container';

export const MOUNT_ALLOWLIST_PATH = path.join(
  os.homedir(),
  '.config',
  'hybridclaw',
  'mount-allowlist.json',
);
export let ADDITIONAL_MOUNTS = '';

export let CONTAINER_MAX_OUTPUT_SIZE = 10_485_760;
export let MAX_CONCURRENT_CONTAINERS = 5;

export let HEARTBEAT_ENABLED = true;
export let HEARTBEAT_INTERVAL = 1_800_000;
export let HEARTBEAT_CHANNEL = '';
export let MEMORY_DECAY_RATE = 0.1;
export let MEMORY_CONSOLIDATION_INTERVAL_HOURS = 24;

export let HEALTH_HOST = '127.0.0.1';
export let HEALTH_PORT = 9090;
export let WEB_API_TOKEN = '';
export let GATEWAY_BASE_URL = 'http://127.0.0.1:9090';
const INTERNAL_GATEWAY_API_TOKEN = randomBytes(24).toString('hex');
export let GATEWAY_API_TOKEN = INTERNAL_GATEWAY_API_TOKEN;
export let DB_PATH = path.join(
  os.homedir(),
  '.hybridclaw',
  'data',
  'hybridclaw.db',
);
export let DATA_DIR = path.dirname(DB_PATH);

export let OBSERVABILITY_ENABLED = true;
export let OBSERVABILITY_BASE_URL = 'https://hybridai.one';
export let OBSERVABILITY_INGEST_PATH =
  '/api/v1/agent-observability/events:batch';
export let OBSERVABILITY_STATUS_PATH = '/api/v1/agent-observability/status';
export let OBSERVABILITY_BOT_ID = '';
export let OBSERVABILITY_AGENT_ID = 'agent_main';
export let OBSERVABILITY_LABEL = '';
export let OBSERVABILITY_ENVIRONMENT = 'prod';
export let OBSERVABILITY_FLUSH_INTERVAL_MS = 10_000;
export let OBSERVABILITY_BATCH_MAX_EVENTS = 500;

export let SESSION_COMPACTION_ENABLED = true;
export let SESSION_COMPACTION_TOKEN_BUDGET = 100_000;
export let SESSION_COMPACTION_BUDGET_RATIO = 0.7;
export let SESSION_COMPACTION_THRESHOLD = 200;
export let SESSION_COMPACTION_KEEP_RECENT = 40;
export let SESSION_COMPACTION_SUMMARY_MAX_CHARS = 8_000;
export let PRE_COMPACTION_MEMORY_FLUSH_ENABLED = true;
export let PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES = 80;
export let PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS = 24_000;

export let PROACTIVE_ACTIVE_HOURS_ENABLED = false;
export let PROACTIVE_ACTIVE_HOURS_TIMEZONE = '';
export let PROACTIVE_ACTIVE_HOURS_START = 8;
export let PROACTIVE_ACTIVE_HOURS_END = 22;
export let PROACTIVE_QUEUE_OUTSIDE_HOURS = true;

export let PROACTIVE_DELEGATION_ENABLED = true;
export let PROACTIVE_DELEGATION_MAX_CONCURRENT = 3;
export let PROACTIVE_DELEGATION_MAX_DEPTH = 2;
export let PROACTIVE_DELEGATION_MAX_PER_TURN = 3;

export let PROACTIVE_AUTO_RETRY_ENABLED = true;
export let PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS = 3;
export let PROACTIVE_AUTO_RETRY_BASE_DELAY_MS = 2_000;
export let PROACTIVE_AUTO_RETRY_MAX_DELAY_MS = 8_000;
export let PROACTIVE_RALPH_MAX_ITERATIONS = 0;

const DOCKER_ENV_PATH = '/.dockerenv';
let sandboxAutoDetectLogged = '';
let sandboxModeOverride: RuntimeConfig['container']['sandboxMode'] | null =
  (() => {
    const raw = String(process.env.HYBRIDCLAW_SANDBOX_MODE_OVERRIDE || '')
      .trim()
      .toLowerCase();
    if (raw === 'host') return 'host';
    if (raw === 'container') return 'container';
    return null;
  })();

function isRunningInsideContainer(): boolean {
  if (process.env.HYBRIDCLAW_IN_CONTAINER === '1') return true;
  try {
    return fs.existsSync(DOCKER_ENV_PATH);
  } catch {
    return false;
  }
}

function resolveSandboxMode(
  config: RuntimeConfig,
): RuntimeConfig['container']['sandboxMode'] {
  if (sandboxModeOverride) return sandboxModeOverride;
  const configuredMode = config.container.sandboxMode;
  const sandboxModeExplicit = isContainerSandboxModeExplicit();
  const runningInsideContainer = isRunningInsideContainer();
  if (sandboxModeExplicit || !runningInsideContainer) return configuredMode;

  const signature = `${configuredMode}:${runningInsideContainer}`;
  if (sandboxAutoDetectLogged !== signature) {
    sandboxAutoDetectLogged = signature;
    console.info(
      'Running in container mode — sandbox disabled (container-in-container not needed)',
    );
  }
  return 'host';
}

function applyRuntimeConfig(config: RuntimeConfig): void {
  DISCORD_PREFIX = config.discord.prefix;
  DISCORD_GUILD_MEMBERS_INTENT = config.discord.guildMembersIntent;
  DISCORD_PRESENCE_INTENT = config.discord.presenceIntent;
  DISCORD_RESPOND_TO_ALL_MESSAGES = config.discord.respondToAllMessages;
  DISCORD_COMMANDS_ONLY = config.discord.commandsOnly;
  DISCORD_COMMAND_MODE = config.discord.commandMode;
  DISCORD_COMMAND_ALLOWED_USER_IDS = [...config.discord.commandAllowedUserIds];
  DISCORD_COMMAND_USER_ID = config.discord.commandUserId;
  DISCORD_GROUP_POLICY = config.discord.groupPolicy;
  DISCORD_SEND_POLICY = config.discord.sendPolicy;
  DISCORD_SEND_ALLOWED_CHANNEL_IDS = [...config.discord.sendAllowedChannelIds];
  DISCORD_FREE_RESPONSE_CHANNELS = [...config.discord.freeResponseChannels];
  DISCORD_TEXT_CHUNK_LIMIT = Math.max(
    200,
    Math.min(2_000, config.discord.textChunkLimit),
  );
  DISCORD_MAX_LINES_PER_MESSAGE = Math.max(
    4,
    Math.min(200, config.discord.maxLinesPerMessage),
  );
  DISCORD_HUMAN_DELAY = JSON.parse(
    JSON.stringify(config.discord.humanDelay),
  ) as RuntimeConfig['discord']['humanDelay'];
  DISCORD_TYPING_MODE = config.discord.typingMode;
  DISCORD_SELF_PRESENCE = JSON.parse(
    JSON.stringify(config.discord.presence),
  ) as RuntimeConfig['discord']['presence'];
  DISCORD_LIFECYCLE_REACTIONS = JSON.parse(
    JSON.stringify(config.discord.lifecycleReactions),
  ) as RuntimeConfig['discord']['lifecycleReactions'];
  DISCORD_ACK_REACTION = config.discord.ackReaction;
  DISCORD_ACK_REACTION_SCOPE = config.discord.ackReactionScope;
  DISCORD_REMOVE_ACK_AFTER_REPLY = config.discord.removeAckAfterReply;
  DISCORD_DEBOUNCE_MS = Math.max(0, config.discord.debounceMs);
  DISCORD_RATE_LIMIT_PER_USER = Math.max(0, config.discord.rateLimitPerUser);
  DISCORD_RATE_LIMIT_EXEMPT_ROLES = [...config.discord.rateLimitExemptRoles];
  DISCORD_SUPPRESS_PATTERNS = [...config.discord.suppressPatterns];
  DISCORD_MAX_CONCURRENT_PER_CHANNEL = Math.max(
    1,
    config.discord.maxConcurrentPerChannel,
  );
  DISCORD_GUILDS = JSON.parse(
    JSON.stringify(config.discord.guilds),
  ) as RuntimeConfig['discord']['guilds'];

  HYBRIDAI_BASE_URL = config.hybridai.baseUrl;
  HYBRIDAI_MODEL = config.hybridai.defaultModel;
  HYBRIDAI_CHATBOT_ID = config.hybridai.defaultChatbotId;
  HYBRIDAI_MAX_TOKENS = Math.max(
    256,
    Math.min(32_768, config.hybridai.maxTokens),
  );
  HYBRIDAI_ENABLE_RAG = config.hybridai.enableRag;
  HYBRIDAI_MODELS = [...config.hybridai.models];

  CONTAINER_SANDBOX_MODE = resolveSandboxMode(config);
  CONTAINER_IMAGE = config.container.image;
  CONTAINER_MEMORY = config.container.memory;
  CONTAINER_MEMORY_SWAP = config.container.memorySwap;
  CONTAINER_CPUS = config.container.cpus;
  CONTAINER_NETWORK = config.container.network;
  CONTAINER_TIMEOUT = config.container.timeoutMs;
  ADDITIONAL_MOUNTS = config.container.additionalMounts;
  CONTAINER_MAX_OUTPUT_SIZE = config.container.maxOutputBytes;
  MAX_CONCURRENT_CONTAINERS = Math.max(1, config.container.maxConcurrent);

  HEARTBEAT_ENABLED = config.heartbeat.enabled;
  HEARTBEAT_INTERVAL = config.heartbeat.intervalMs;
  HEARTBEAT_CHANNEL = config.heartbeat.channel;
  MEMORY_DECAY_RATE = config.memory.decayRate;
  MEMORY_CONSOLIDATION_INTERVAL_HOURS =
    config.memory.consolidationIntervalHours;

  HEALTH_HOST = config.ops.healthHost;
  HEALTH_PORT = config.ops.healthPort;
  WEB_API_TOKEN = process.env.WEB_API_TOKEN || config.ops.webApiToken;
  GATEWAY_BASE_URL = config.ops.gatewayBaseUrl;
  GATEWAY_API_TOKEN =
    process.env.GATEWAY_API_TOKEN ||
    config.ops.gatewayApiToken ||
    WEB_API_TOKEN ||
    INTERNAL_GATEWAY_API_TOKEN;
  DB_PATH = config.ops.dbPath;
  DATA_DIR = path.dirname(DB_PATH);

  OBSERVABILITY_ENABLED = config.observability.enabled;
  OBSERVABILITY_BASE_URL = config.observability.baseUrl;
  OBSERVABILITY_INGEST_PATH = config.observability.ingestPath;
  OBSERVABILITY_STATUS_PATH = config.observability.statusPath;
  OBSERVABILITY_BOT_ID = config.observability.botId;
  OBSERVABILITY_AGENT_ID = config.observability.agentId;
  OBSERVABILITY_LABEL = config.observability.label;
  OBSERVABILITY_ENVIRONMENT = config.observability.environment;
  OBSERVABILITY_FLUSH_INTERVAL_MS = Math.max(
    1_000,
    config.observability.flushIntervalMs,
  );
  OBSERVABILITY_BATCH_MAX_EVENTS = Math.max(
    1,
    Math.min(1_000, config.observability.batchMaxEvents),
  );

  SESSION_COMPACTION_ENABLED = config.sessionCompaction.enabled;
  SESSION_COMPACTION_TOKEN_BUDGET = Math.max(
    1_000,
    config.sessionCompaction.tokenBudget,
  );
  SESSION_COMPACTION_BUDGET_RATIO = Math.max(
    0.05,
    Math.min(1, config.sessionCompaction.budgetRatio),
  );
  SESSION_COMPACTION_THRESHOLD = Math.max(
    20,
    config.sessionCompaction.threshold,
  );
  SESSION_COMPACTION_KEEP_RECENT = Math.max(
    1,
    Math.min(
      config.sessionCompaction.keepRecent,
      SESSION_COMPACTION_THRESHOLD - 1,
    ),
  );
  SESSION_COMPACTION_SUMMARY_MAX_CHARS = Math.max(
    1_000,
    config.sessionCompaction.summaryMaxChars,
  );
  PRE_COMPACTION_MEMORY_FLUSH_ENABLED =
    config.sessionCompaction.preCompactionMemoryFlush.enabled;
  PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES = Math.max(
    8,
    config.sessionCompaction.preCompactionMemoryFlush.maxMessages,
  );
  PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS = Math.max(
    4_000,
    config.sessionCompaction.preCompactionMemoryFlush.maxChars,
  );

  PROACTIVE_ACTIVE_HOURS_ENABLED = config.proactive.activeHours.enabled;
  PROACTIVE_ACTIVE_HOURS_TIMEZONE = config.proactive.activeHours.timezone;
  PROACTIVE_ACTIVE_HOURS_START = Math.max(
    0,
    Math.min(23, config.proactive.activeHours.startHour),
  );
  PROACTIVE_ACTIVE_HOURS_END = Math.max(
    0,
    Math.min(23, config.proactive.activeHours.endHour),
  );
  PROACTIVE_QUEUE_OUTSIDE_HOURS =
    config.proactive.activeHours.queueOutsideHours;

  PROACTIVE_DELEGATION_ENABLED = config.proactive.delegation.enabled;
  PROACTIVE_DELEGATION_MAX_CONCURRENT = Math.max(
    1,
    config.proactive.delegation.maxConcurrent,
  );
  PROACTIVE_DELEGATION_MAX_DEPTH = Math.max(
    1,
    config.proactive.delegation.maxDepth,
  );
  PROACTIVE_DELEGATION_MAX_PER_TURN = Math.max(
    1,
    config.proactive.delegation.maxPerTurn,
  );

  PROACTIVE_AUTO_RETRY_ENABLED = config.proactive.autoRetry.enabled;
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS = Math.max(
    1,
    config.proactive.autoRetry.maxAttempts,
  );
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS = Math.max(
    100,
    config.proactive.autoRetry.baseDelayMs,
  );
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS = Math.max(
    PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
    config.proactive.autoRetry.maxDelayMs,
  );

  const rawRalphMax = Math.trunc(config.proactive.ralph.maxIterations);
  PROACTIVE_RALPH_MAX_ITERATIONS =
    rawRalphMax === -1 ? -1 : Math.max(0, rawRalphMax);
}

applyRuntimeConfig(getRuntimeConfig());
onRuntimeConfigChange((next) => {
  applyRuntimeConfig(next);
});

export { onRuntimeConfigChange as onConfigChange };
export function getConfigSnapshot(): RuntimeConfig {
  return getRuntimeConfig();
}

export function getResolvedSandboxMode(): RuntimeConfig['container']['sandboxMode'] {
  return CONTAINER_SANDBOX_MODE;
}

export function setSandboxModeOverride(
  mode: RuntimeConfig['container']['sandboxMode'] | null,
): void {
  sandboxModeOverride = mode;
  if (mode) {
    process.env.HYBRIDCLAW_SANDBOX_MODE_OVERRIDE = mode;
  } else {
    delete process.env.HYBRIDCLAW_SANDBOX_MODE_OVERRIDE;
  }
  applyRuntimeConfig(getRuntimeConfig());
}

export function getSandboxAutoDetectionState(): {
  runningInsideContainer: boolean;
  sandboxModeExplicit: boolean;
} {
  return {
    runningInsideContainer: isRunningInsideContainer(),
    sandboxModeExplicit:
      sandboxModeOverride != null || isContainerSandboxModeExplicit(),
  };
}
