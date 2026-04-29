import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTEXT_GUARD_DEFAULTS,
  normalizeContextGuardConfig,
} from '../../container/shared/context-guard-config.js';
import { logger } from '../logger.js';
import { CODEX_DEFAULT_BASE_URL } from '../providers/codex-constants.js';
import {
  loadRuntimeSecrets,
  type RuntimeSecretKey,
  readStoredRuntimeSecrets,
  saveRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { bootstrapRuntimeSecrets } from '../security/runtime-secrets-bootstrap.js';
import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  isContainerSandboxModeExplicit,
  onRuntimeConfigChange,
  type RuntimeConfig,
} from './runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from './runtime-paths.js';

export type {
  AIProviderId as ModelProvider,
  ResolvedModelRuntimeCredentials,
} from '../providers/types.js';

bootstrapRuntimeSecrets();
ensureRuntimeConfigFile();

export class MissingRequiredEnvVarError extends Error {
  constructor(public readonly envVar: string) {
    const messageByEnvVar: Record<string, string> = {
      HYBRIDAI_API_KEY:
        'HybridAI provider is not configured. Use `/auth login hybridai` in the TUI, or switch to a model from another configured provider.',
      OPENROUTER_API_KEY:
        'OpenRouter provider is not configured. Use `/auth login openrouter` in the TUI, or switch to a model from another configured provider.',
      MISTRAL_API_KEY:
        'Mistral provider is not configured. Use `/auth login mistral` in the TUI, or switch to a model from another configured provider.',
      HF_TOKEN:
        'Hugging Face provider is not configured. Use `/auth login huggingface` in the TUI, or switch to a model from another configured provider.',
      ANTHROPIC_API_KEY:
        'Anthropic provider is not configured. Use `/auth login anthropic --method api-key` in the TUI, or switch to a model from another configured provider.',
      GEMINI_API_KEY:
        'Google Gemini provider is not configured. Use `/auth login gemini` in the TUI, or switch to a model from another configured provider.',
      DEEPSEEK_API_KEY:
        'DeepSeek provider is not configured. Use `/auth login deepseek` in the TUI, or switch to a model from another configured provider.',
      XAI_API_KEY:
        'xAI provider is not configured. Use `/auth login xai` in the TUI, or switch to a model from another configured provider.',
      ZAI_API_KEY:
        'Z.AI / GLM provider is not configured. Use `/auth login zai` in the TUI, or switch to a model from another configured provider.',
      KIMI_API_KEY:
        'Kimi / Moonshot provider is not configured. Use `/auth login kimi` in the TUI, or switch to a model from another configured provider.',
      MINIMAX_API_KEY:
        'MiniMax provider is not configured. Use `/auth login minimax` in the TUI, or switch to a model from another configured provider.',
      DASHSCOPE_API_KEY:
        'DashScope / Qwen provider is not configured. Use `/auth login dashscope` in the TUI, or switch to a model from another configured provider.',
      XIAOMI_API_KEY:
        'Xiaomi / MiMo provider is not configured. Use `/auth login xiaomi` in the TUI, or switch to a model from another configured provider.',
      KILO_API_KEY:
        'Kilo Code provider is not configured. Use `/auth login kilo` in the TUI, or switch to a model from another configured provider.',
    };
    super(
      messageByEnvVar[envVar] ||
        `Required credential is not configured: ${envVar}.`,
    );
    this.name = 'MissingRequiredEnvVarError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readVersionFromPackageJson(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed.version === 'string' &&
      parsed.version.trim()
    ) {
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
  const probePaths = [
    path.join(path.dirname(modulePath), '..', '..', 'package.json'),
  ];
  const moduleVersion = readVersionFromPackageJson(probePaths[0]);
  if (moduleVersion) return moduleVersion;

  const entryPath = process.argv[1];
  if (entryPath) {
    const entryPackagePath = path.join(
      path.dirname(path.resolve(entryPath)),
      '..',
      'package.json',
    );
    probePaths.push(entryPackagePath);
    const entryVersion = readVersionFromPackageJson(entryPackagePath);
    if (entryVersion) return entryVersion;
  }

  const cwdPackagePath = path.join(process.cwd(), 'package.json');
  probePaths.push(cwdPackagePath);
  const cwdVersion = readVersionFromPackageJson(cwdPackagePath);
  if (cwdVersion) return cwdVersion;

  logger.warn(
    { probePaths: Array.from(new Set(probePaths)) },
    'Unable to resolve app version from package.json probes; falling back to 0.0.0',
  );
  return '0.0.0';
}

export const APP_VERSION = resolveAppVersion();

function readRuntimeSecretValue(
  envKeys: string[],
  storedKey: RuntimeSecretKey,
  storedSecrets: Record<string, string>,
): string {
  // Prefer the encrypted runtime store over the live process environment so
  // persisted credentials remain authoritative for long-running gateway and
  // runner processes.
  const canonical = storedSecrets[storedKey]?.trim();
  if (canonical) return canonical;
  for (const envKey of envKeys) {
    const stored = storedSecrets[envKey]?.trim();
    if (stored) return stored;
  }
  for (const envKey of envKeys) {
    const value = String(process.env[envKey] || '').trim();
    if (value) return value;
  }
  return '';
}

function syncRuntimeSecretExports(): void {
  const storedSecrets = readStoredRuntimeSecrets();
  DISCORD_TOKEN = readRuntimeSecretValue(
    ['DISCORD_TOKEN'],
    'DISCORD_TOKEN',
    storedSecrets,
  );
  EMAIL_PASSWORD = readRuntimeSecretValue(
    ['EMAIL_PASSWORD'],
    'EMAIL_PASSWORD',
    storedSecrets,
  );
  TELEGRAM_BOT_TOKEN = readRuntimeSecretValue(
    ['TELEGRAM_BOT_TOKEN'],
    'TELEGRAM_BOT_TOKEN',
    storedSecrets,
  );
  IMESSAGE_PASSWORD = readRuntimeSecretValue(
    ['IMESSAGE_PASSWORD'],
    'IMESSAGE_PASSWORD',
    storedSecrets,
  );
  TWILIO_AUTH_TOKEN = readRuntimeSecretValue(
    ['TWILIO_AUTH_TOKEN'],
    'TWILIO_AUTH_TOKEN',
    storedSecrets,
  );
  MSTEAMS_APP_PASSWORD = readRuntimeSecretValue(
    ['MSTEAMS_APP_PASSWORD'],
    'MSTEAMS_APP_PASSWORD',
    storedSecrets,
  );
  SLACK_BOT_TOKEN = readRuntimeSecretValue(
    ['SLACK_BOT_TOKEN'],
    'SLACK_BOT_TOKEN',
    storedSecrets,
  );
  SLACK_APP_TOKEN = readRuntimeSecretValue(
    ['SLACK_APP_TOKEN'],
    'SLACK_APP_TOKEN',
    storedSecrets,
  );
  HYBRIDAI_API_KEY = readRuntimeSecretValue(
    ['HYBRIDAI_API_KEY'],
    'HYBRIDAI_API_KEY',
    storedSecrets,
  );
  OPENROUTER_API_KEY = readRuntimeSecretValue(
    ['OPENROUTER_API_KEY'],
    'OPENROUTER_API_KEY',
    storedSecrets,
  );
  MISTRAL_API_KEY = readRuntimeSecretValue(
    ['MISTRAL_API_KEY'],
    'MISTRAL_API_KEY',
    storedSecrets,
  );
  ANTHROPIC_API_KEY = readRuntimeSecretValue(
    ['ANTHROPIC_API_KEY'],
    'ANTHROPIC_API_KEY',
    storedSecrets,
  );
  HUGGINGFACE_API_KEY = readRuntimeSecretValue(
    ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
    'HF_TOKEN',
    storedSecrets,
  );
  GEMINI_API_KEY = readRuntimeSecretValue(
    ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    'GEMINI_API_KEY',
    storedSecrets,
  );
  DEEPSEEK_API_KEY = readRuntimeSecretValue(
    ['DEEPSEEK_API_KEY'],
    'DEEPSEEK_API_KEY',
    storedSecrets,
  );
  XAI_API_KEY = readRuntimeSecretValue(
    ['XAI_API_KEY'],
    'XAI_API_KEY',
    storedSecrets,
  );
  ZAI_API_KEY = readRuntimeSecretValue(
    ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
    'ZAI_API_KEY',
    storedSecrets,
  );
  KIMI_API_KEY = readRuntimeSecretValue(
    ['KIMI_API_KEY'],
    'KIMI_API_KEY',
    storedSecrets,
  );
  MINIMAX_API_KEY = readRuntimeSecretValue(
    ['MINIMAX_API_KEY'],
    'MINIMAX_API_KEY',
    storedSecrets,
  );
  DASHSCOPE_API_KEY = readRuntimeSecretValue(
    ['DASHSCOPE_API_KEY'],
    'DASHSCOPE_API_KEY',
    storedSecrets,
  );
  XIAOMI_API_KEY = readRuntimeSecretValue(
    ['XIAOMI_API_KEY'],
    'XIAOMI_API_KEY',
    storedSecrets,
  );
  KILO_API_KEY = readRuntimeSecretValue(
    ['KILOCODE_API_KEY', 'KILO_API_KEY'],
    'KILO_API_KEY',
    storedSecrets,
  );
  BRAVE_API_KEY = readRuntimeSecretValue(
    ['BRAVE_API_KEY'],
    'BRAVE_API_KEY',
    storedSecrets,
  );
  PERPLEXITY_API_KEY = readRuntimeSecretValue(
    ['PERPLEXITY_API_KEY'],
    'PERPLEXITY_API_KEY',
    storedSecrets,
  );
  TAVILY_API_KEY = readRuntimeSecretValue(
    ['TAVILY_API_KEY'],
    'TAVILY_API_KEY',
    storedSecrets,
  );
}

export let DISCORD_TOKEN = '';
export let EMAIL_PASSWORD = '';
export let TELEGRAM_BOT_TOKEN = '';
export let IMESSAGE_PASSWORD = '';
export let TWILIO_AUTH_TOKEN = '';
export let MSTEAMS_APP_PASSWORD = '';
export let SLACK_BOT_TOKEN = '';
export let SLACK_APP_TOKEN = '';
export let HYBRIDAI_API_KEY = '';
export let OPENROUTER_API_KEY = '';
export let MISTRAL_API_KEY = '';
export let ANTHROPIC_API_KEY = '';
export let HUGGINGFACE_API_KEY = '';
export let GEMINI_API_KEY = '';
export let DEEPSEEK_API_KEY = '';
export let XAI_API_KEY = '';
export let ZAI_API_KEY = '';
export let KIMI_API_KEY = '';
export let MINIMAX_API_KEY = '';
export let DASHSCOPE_API_KEY = '';
export let XIAOMI_API_KEY = '';
export let KILO_API_KEY = '';
export let BRAVE_API_KEY = '';
export let PERPLEXITY_API_KEY = '';
export let TAVILY_API_KEY = '';
syncRuntimeSecretExports();

export function refreshRuntimeSecretsFromEnv(): void {
  loadRuntimeSecrets();
  syncRuntimeSecretExports();
}

export let DISCORD_PREFIX = '!claw';
export let DISCORD_GUILD_MEMBERS_INTENT = false;
export let DISCORD_PRESENCE_INTENT = false;
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
export let MSTEAMS_ENABLED = false;
export let MSTEAMS_APP_ID = '';
export let MSTEAMS_TENANT_ID = '';
export let MSTEAMS_WEBHOOK_PORT = 3_978;
export let MSTEAMS_WEBHOOK_PATH = '/api/msteams/messages';
export let MSTEAMS_GROUP_POLICY: RuntimeConfig['msteams']['groupPolicy'] =
  'allowlist';
export let MSTEAMS_DM_POLICY: RuntimeConfig['msteams']['dmPolicy'] =
  'allowlist';
export let MSTEAMS_ALLOW_FROM: string[] = [];
export let MSTEAMS_TEAMS: RuntimeConfig['msteams']['teams'] = {};
export let MSTEAMS_REQUIRE_MENTION = true;
export let MSTEAMS_TEXT_CHUNK_LIMIT = 4_000;
export let MSTEAMS_REPLY_STYLE: RuntimeConfig['msteams']['replyStyle'] =
  'thread';
export let MSTEAMS_MEDIA_MAX_MB = 20;
export let MSTEAMS_DANGEROUSLY_ALLOW_NAME_MATCHING = false;
export let MSTEAMS_MEDIA_ALLOW_HOSTS: string[] = [];
export let MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS: string[] = [];
export let SLACK_ENABLED = false;
export let SLACK_GROUP_POLICY: RuntimeConfig['slack']['groupPolicy'] =
  'allowlist';
export let SLACK_DM_POLICY: RuntimeConfig['slack']['dmPolicy'] = 'allowlist';
export let SLACK_ALLOW_FROM: string[] = [];
export let SLACK_GROUP_ALLOW_FROM: string[] = [];
export let SLACK_REQUIRE_MENTION = true;
export let SLACK_TEXT_CHUNK_LIMIT = 12_000;
export let SLACK_REPLY_STYLE: RuntimeConfig['slack']['replyStyle'] = 'thread';
export let SLACK_MEDIA_MAX_MB = 20;
export let WHATSAPP_DM_POLICY: RuntimeConfig['whatsapp']['dmPolicy'] =
  'pairing';
export let WHATSAPP_GROUP_POLICY: RuntimeConfig['whatsapp']['groupPolicy'] =
  'disabled';
export let WHATSAPP_ALLOW_FROM: string[] = [];
export let WHATSAPP_GROUP_ALLOW_FROM: string[] = [];
export let WHATSAPP_TEXT_CHUNK_LIMIT = 4_000;
export let WHATSAPP_DEBOUNCE_MS = 2_500;
export let WHATSAPP_SEND_READ_RECEIPTS = true;
export let WHATSAPP_ACK_REACTION = '';
export let WHATSAPP_MEDIA_MAX_MB = 20;
export let VOICE_ENABLED = false;
export let VOICE_PROVIDER: RuntimeConfig['voice']['provider'] = 'twilio';
export let VOICE_TWILIO_ACCOUNT_SID = '';
export let VOICE_TWILIO_FROM_NUMBER = '';
export let VOICE_RELAY_TTS_PROVIDER: RuntimeConfig['voice']['relay']['ttsProvider'] =
  'default';
export let VOICE_RELAY_VOICE = '';
export let VOICE_RELAY_TRANSCRIPTION_PROVIDER: RuntimeConfig['voice']['relay']['transcriptionProvider'] =
  'default';
export let VOICE_RELAY_LANGUAGE = 'en-US';
export let VOICE_RELAY_INTERRUPTIBLE = true;
export let VOICE_RELAY_WELCOME_GREETING = 'Hello! How can I help you today?';
export let VOICE_WEBHOOK_PATH = '/voice';
export let VOICE_MAX_CONCURRENT_CALLS = 8;
export let IMESSAGE_ENABLED = false;
export let IMESSAGE_BACKEND: RuntimeConfig['imessage']['backend'] = 'local';
export let IMESSAGE_CLI_PATH = 'imsg';
export let IMESSAGE_DB_PATH = '';
export let IMESSAGE_POLL_INTERVAL_MS = 2_500;
export let IMESSAGE_SERVER_URL = '';
export let IMESSAGE_WEBHOOK_PATH = '/api/imessage/webhook';
export let IMESSAGE_ALLOW_PRIVATE_NETWORK = false;
export let IMESSAGE_DM_POLICY: RuntimeConfig['imessage']['dmPolicy'] =
  'allowlist';
export let IMESSAGE_GROUP_POLICY: RuntimeConfig['imessage']['groupPolicy'] =
  'disabled';
export let IMESSAGE_ALLOW_FROM: string[] = [];
export let IMESSAGE_GROUP_ALLOW_FROM: string[] = [];
export let IMESSAGE_TEXT_CHUNK_LIMIT = 4_000;
export let IMESSAGE_DEBOUNCE_MS = 2_500;
export let IMESSAGE_MEDIA_MAX_MB = 20;
export let EMAIL_ENABLED = false;
export let EMAIL_IMAP_HOST = '';
export let EMAIL_IMAP_PORT = 993;
export let EMAIL_IMAP_SECURE = true;
export let EMAIL_SMTP_HOST = '';
export let EMAIL_SMTP_PORT = 587;
export let EMAIL_SMTP_SECURE = false;
export let EMAIL_ADDRESS = '';
export let EMAIL_POLL_INTERVAL_MS = 30_000;
export let EMAIL_FOLDERS: string[] = ['INBOX'];
export let EMAIL_ALLOW_FROM: string[] = [];
export let EMAIL_TEXT_CHUNK_LIMIT = 50_000;
export let EMAIL_MEDIA_MAX_MB = 20;

export let HYBRIDAI_BASE_URL = 'https://hybridai.one';
export let HYBRIDAI_MODEL = 'gpt-4.1-mini';
export let HYBRIDAI_CHATBOT_ID = '';
export let HYBRIDAI_MAX_TOKENS = 4_096;
export let HYBRIDAI_ENABLE_RAG = true;
export let CODEX_BASE_URL = CODEX_DEFAULT_BASE_URL;
export let ANTHROPIC_ENABLED = false;
export let ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export let ANTHROPIC_METHOD: RuntimeConfig['anthropic']['method'] = 'api-key';
export let OPENROUTER_ENABLED = false;
export let OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export let MISTRAL_ENABLED = false;
export let MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
export let HUGGINGFACE_ENABLED = false;
export let HUGGINGFACE_BASE_URL = 'https://router.huggingface.co/v1';
export let GEMINI_ENABLED = false;
export let GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai';
export let DEEPSEEK_ENABLED = false;
export let DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export let XAI_ENABLED = false;
export let XAI_BASE_URL = 'https://api.x.ai/v1';
export let ZAI_ENABLED = false;
export let ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
export let KIMI_ENABLED = false;
export let KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
export let MINIMAX_ENABLED = false;
export let MINIMAX_BASE_URL = 'https://api.minimax.io/v1';
export let DASHSCOPE_ENABLED = false;
export let DASHSCOPE_BASE_URL =
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export let XIAOMI_ENABLED = false;
export let XIAOMI_BASE_URL = 'https://api.xiaomimimo.com/v1';
export let KILO_ENABLED = false;
export let KILO_BASE_URL = 'https://api.kilo.ai/api/gateway';
export let LOCAL_OLLAMA_ENABLED = true;
export let LOCAL_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export let LOCAL_LMSTUDIO_ENABLED = false;
export let LOCAL_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';
export let LOCAL_LLAMACPP_ENABLED = false;
export let LOCAL_LLAMACPP_BASE_URL = 'http://127.0.0.1:8081/v1';
export let LOCAL_VLLM_ENABLED = false;
export let LOCAL_VLLM_BASE_URL = 'http://127.0.0.1:8000/v1';
export let LOCAL_VLLM_API_KEY = '';
export let LOCAL_DISCOVERY_ENABLED = true;
export let LOCAL_DISCOVERY_INTERVAL_MS = 3_600_000;
export let LOCAL_DISCOVERY_MAX_MODELS = 200;
export let LOCAL_DISCOVERY_CONCURRENCY = 8;
export let LOCAL_HEALTH_CHECK_ENABLED = true;
export let LOCAL_HEALTH_CHECK_INTERVAL_MS = 60_000;
export let LOCAL_HEALTH_CHECK_TIMEOUT_MS = 5_000;
export let LOCAL_DEFAULT_CONTEXT_WINDOW = 128_000;
export let LOCAL_DEFAULT_MAX_TOKENS = 8_192;

export let CONTAINER_IMAGE = 'hybridclaw-agent';
export let CONTAINER_MEMORY = '512m';
export let CONTAINER_MEMORY_SWAP = '';
export let CONTAINER_CPUS = '1';
export let CONTAINER_NETWORK = 'bridge';
export let CONTAINER_TIMEOUT = 300_000;
export let CONTAINER_SANDBOX_MODE: RuntimeConfig['container']['sandboxMode'] =
  'container';
export let CONTAINER_BINDS: string[] = [];

export const MOUNT_ALLOWLIST_PATH = path.join(
  os.homedir(),
  '.config',
  'hybridclaw',
  'mount-allowlist.json',
);
export let ADDITIONAL_MOUNTS = '';

export let CONTAINER_MAX_OUTPUT_SIZE = 10_485_760;
export let MAX_CONCURRENT_CONTAINERS = 5;
export let CONTAINER_PERSIST_BASH_STATE = true;
export let MCP_SERVERS: RuntimeConfig['mcpServers'] = {};
export let WEB_SEARCH_PROVIDER: RuntimeConfig['web']['search']['provider'] =
  'auto';
export let WEB_SEARCH_FALLBACK_PROVIDERS: RuntimeConfig['web']['search']['fallbackProviders'] =
  [];
export let WEB_SEARCH_DEFAULT_COUNT = 5;
export let WEB_SEARCH_CACHE_TTL_MINUTES = 5;
export let WEB_SEARCH_SEARXNG_BASE_URL = '';
export let WEB_SEARCH_TAVILY_SEARCH_DEPTH: RuntimeConfig['web']['search']['tavilySearchDepth'] =
  'advanced';

export let HEARTBEAT_ENABLED = true;
export let HEARTBEAT_INTERVAL = 1_800_000;
export let HEARTBEAT_CHANNEL = '';
export let MEMORY_DECAY_RATE = 0.1;
export let MEMORY_CONSOLIDATION_INTERVAL_HOURS = 24;

export let HEALTH_HOST = '127.0.0.1';
export let HEALTH_PORT = 9090;
export let WEB_API_TOKEN = '';
export let GATEWAY_BASE_URL = 'http://127.0.0.1:9090';
let internalGatewayApiToken = '';
let internalGatewayApiTokenPersisted = false;
function getInternalGatewayApiToken(): string {
  if (!internalGatewayApiToken) {
    internalGatewayApiToken = randomBytes(24).toString('hex');
  }
  return internalGatewayApiToken;
}

function getOrPersistGatewayApiToken(): string {
  const token = getInternalGatewayApiToken();
  if (internalGatewayApiTokenPersisted) return token;
  try {
    saveRuntimeSecrets({ GATEWAY_API_TOKEN: token });
    internalGatewayApiTokenPersisted = true;
  } catch (err) {
    logger.warn(
      { err },
      'Failed to persist generated gateway API token; local gateway clients in other processes may need an explicit GATEWAY_API_TOKEN.',
    );
  }
  return token;
}
export let GATEWAY_API_TOKEN = '';
export let DB_PATH = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
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
export let CONTEXT_GUARD_ENABLED = CONTEXT_GUARD_DEFAULTS.enabled;
export let CONTEXT_GUARD_PER_RESULT_SHARE =
  CONTEXT_GUARD_DEFAULTS.perResultShare;
export let CONTEXT_GUARD_COMPACTION_RATIO =
  CONTEXT_GUARD_DEFAULTS.compactionRatio;
export let CONTEXT_GUARD_OVERFLOW_RATIO = CONTEXT_GUARD_DEFAULTS.overflowRatio;
export let CONTEXT_GUARD_MAX_RETRIES = CONTEXT_GUARD_DEFAULTS.maxRetries;

export let PROACTIVE_ACTIVE_HOURS_ENABLED = false;
export let PROACTIVE_ACTIVE_HOURS_TIMEZONE = '';
export let PROACTIVE_ACTIVE_HOURS_START = 8;
export let PROACTIVE_ACTIVE_HOURS_END = 22;
export let PROACTIVE_QUEUE_OUTSIDE_HOURS = true;

export let PROACTIVE_DELEGATION_ENABLED = true;
export let PROACTIVE_DELEGATION_MODEL = '';
export let PROACTIVE_DELEGATION_MAX_CONCURRENT = 3;
export let PROACTIVE_DELEGATION_MAX_DEPTH = 2;
export let PROACTIVE_DELEGATION_MAX_PER_TURN = 3;

export let PROACTIVE_AUTO_RETRY_ENABLED = true;
export let PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS = 3;
export let PROACTIVE_AUTO_RETRY_BASE_DELAY_MS = 2_000;
export let PROACTIVE_AUTO_RETRY_MAX_DELAY_MS = 8_000;
export let PROACTIVE_RALPH_MAX_ITERATIONS = 0;
export const FULLAUTO_COOLDOWN_MS = 3_000;
export const FULLAUTO_RESUME_ON_BOOT_DELAY_MS = 3_000;
export const FULLAUTO_MAX_CONSECUTIVE_TURNS = 1_000;
export const FULLAUTO_MAX_CONSECUTIVE_ERRORS = 3;
export const FULLAUTO_MAX_CONSECUTIVE_STALLS = 3;
export const FULLAUTO_DEFAULT_PROMPT = 'Continue working on your current task.';
export const FULLAUTO_NEVER_APPROVE_TOOLS: string[] = ['admin:shutdown'];
export const FULLAUTO_MAX_SESSION_COST_USD = 0;
export const FULLAUTO_MAX_SESSION_TOTAL_TOKENS = 0;
export const FULLAUTO_STALL_TIMEOUT_MS = 90_000;
export const FULLAUTO_STALL_POLL_MS = 5_000;
export const FULLAUTO_STALL_RECOVERY_DELAY_MS = 5_000;

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

function normalizeConfiguredBaseUrl(
  raw: string | undefined,
  fallback: string,
): string {
  const trimmed = String(raw || '')
    .trim()
    .replace(/\/+$/, '');
  return trimmed || fallback;
}

function applyRuntimeConfig(config: RuntimeConfig): void {
  const storedSecrets = readStoredRuntimeSecrets();
  DISCORD_PREFIX = config.discord.prefix;
  DISCORD_GUILD_MEMBERS_INTENT = config.discord.guildMembersIntent;
  DISCORD_PRESENCE_INTENT = config.discord.presenceIntent;
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
  DISCORD_HUMAN_DELAY = structuredClone(config.discord.humanDelay);
  DISCORD_TYPING_MODE = config.discord.typingMode;
  DISCORD_SELF_PRESENCE = structuredClone(config.discord.presence);
  DISCORD_LIFECYCLE_REACTIONS = structuredClone(
    config.discord.lifecycleReactions,
  );
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
  DISCORD_GUILDS = structuredClone(config.discord.guilds);
  MSTEAMS_ENABLED = config.msteams.enabled;
  MSTEAMS_APP_ID = process.env.MSTEAMS_APP_ID || config.msteams.appId;
  MSTEAMS_APP_PASSWORD =
    readRuntimeSecretValue(
      ['MSTEAMS_APP_PASSWORD'],
      'MSTEAMS_APP_PASSWORD',
      storedSecrets,
    ) || '';
  MSTEAMS_TENANT_ID = process.env.MSTEAMS_TENANT_ID || config.msteams.tenantId;
  MSTEAMS_WEBHOOK_PORT = Math.max(
    1,
    Math.min(65_535, config.msteams.webhook.port),
  );
  MSTEAMS_WEBHOOK_PATH = config.msteams.webhook.path;
  MSTEAMS_GROUP_POLICY = config.msteams.groupPolicy;
  MSTEAMS_DM_POLICY = config.msteams.dmPolicy;
  MSTEAMS_ALLOW_FROM = [...config.msteams.allowFrom];
  MSTEAMS_TEAMS = structuredClone(config.msteams.teams);
  MSTEAMS_REQUIRE_MENTION = config.msteams.requireMention;
  MSTEAMS_TEXT_CHUNK_LIMIT = Math.max(
    200,
    Math.min(20_000, config.msteams.textChunkLimit),
  );
  MSTEAMS_REPLY_STYLE = config.msteams.replyStyle;
  MSTEAMS_MEDIA_MAX_MB = Math.max(1, config.msteams.mediaMaxMb);
  MSTEAMS_DANGEROUSLY_ALLOW_NAME_MATCHING =
    config.msteams.dangerouslyAllowNameMatching;
  MSTEAMS_MEDIA_ALLOW_HOSTS = [...config.msteams.mediaAllowHosts];
  MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS = [...config.msteams.mediaAuthAllowHosts];
  SLACK_ENABLED = config.slack.enabled;
  SLACK_BOT_TOKEN =
    readRuntimeSecretValue(
      ['SLACK_BOT_TOKEN'],
      'SLACK_BOT_TOKEN',
      storedSecrets,
    ) || '';
  SLACK_APP_TOKEN =
    readRuntimeSecretValue(
      ['SLACK_APP_TOKEN'],
      'SLACK_APP_TOKEN',
      storedSecrets,
    ) || '';
  SLACK_GROUP_POLICY = config.slack.groupPolicy;
  SLACK_DM_POLICY = config.slack.dmPolicy;
  SLACK_ALLOW_FROM = [...config.slack.allowFrom];
  SLACK_GROUP_ALLOW_FROM = [...config.slack.groupAllowFrom];
  SLACK_REQUIRE_MENTION = config.slack.requireMention;
  SLACK_TEXT_CHUNK_LIMIT = Math.max(
    200,
    Math.min(40_000, config.slack.textChunkLimit),
  );
  SLACK_REPLY_STYLE = config.slack.replyStyle;
  SLACK_MEDIA_MAX_MB = Math.max(1, config.slack.mediaMaxMb);
  WHATSAPP_DM_POLICY = config.whatsapp.dmPolicy;
  WHATSAPP_GROUP_POLICY = config.whatsapp.groupPolicy;
  WHATSAPP_ALLOW_FROM = [...config.whatsapp.allowFrom];
  WHATSAPP_GROUP_ALLOW_FROM = [...config.whatsapp.groupAllowFrom];
  WHATSAPP_TEXT_CHUNK_LIMIT = Math.max(
    200,
    Math.min(4_000, config.whatsapp.textChunkLimit),
  );
  WHATSAPP_DEBOUNCE_MS = Math.max(0, config.whatsapp.debounceMs);
  WHATSAPP_SEND_READ_RECEIPTS = config.whatsapp.sendReadReceipts;
  WHATSAPP_ACK_REACTION = config.whatsapp.ackReaction;
  WHATSAPP_MEDIA_MAX_MB = Math.max(1, config.whatsapp.mediaMaxMb);
  VOICE_ENABLED = config.voice.enabled;
  VOICE_PROVIDER = config.voice.provider;
  VOICE_TWILIO_ACCOUNT_SID = config.voice.twilio.accountSid;
  VOICE_TWILIO_FROM_NUMBER = config.voice.twilio.fromNumber;
  TWILIO_AUTH_TOKEN =
    readRuntimeSecretValue(
      ['TWILIO_AUTH_TOKEN'],
      'TWILIO_AUTH_TOKEN',
      storedSecrets,
    ) || config.voice.twilio.authToken;
  VOICE_RELAY_TTS_PROVIDER = config.voice.relay.ttsProvider;
  VOICE_RELAY_VOICE = config.voice.relay.voice;
  VOICE_RELAY_TRANSCRIPTION_PROVIDER = config.voice.relay.transcriptionProvider;
  VOICE_RELAY_LANGUAGE = config.voice.relay.language;
  VOICE_RELAY_INTERRUPTIBLE = config.voice.relay.interruptible;
  VOICE_RELAY_WELCOME_GREETING = config.voice.relay.welcomeGreeting;
  VOICE_WEBHOOK_PATH = config.voice.webhookPath;
  VOICE_MAX_CONCURRENT_CALLS = Math.max(1, config.voice.maxConcurrentCalls);
  IMESSAGE_ENABLED = config.imessage.enabled;
  IMESSAGE_BACKEND = config.imessage.backend;
  IMESSAGE_CLI_PATH = config.imessage.cliPath;
  IMESSAGE_DB_PATH = config.imessage.dbPath;
  IMESSAGE_POLL_INTERVAL_MS = Math.max(250, config.imessage.pollIntervalMs);
  IMESSAGE_SERVER_URL = config.imessage.serverUrl;
  IMESSAGE_PASSWORD =
    readRuntimeSecretValue(
      ['IMESSAGE_PASSWORD'],
      'IMESSAGE_PASSWORD',
      storedSecrets,
    ) || config.imessage.password;
  IMESSAGE_WEBHOOK_PATH = config.imessage.webhookPath;
  IMESSAGE_ALLOW_PRIVATE_NETWORK = config.imessage.allowPrivateNetwork;
  IMESSAGE_DM_POLICY = config.imessage.dmPolicy;
  IMESSAGE_GROUP_POLICY = config.imessage.groupPolicy;
  IMESSAGE_ALLOW_FROM = [...config.imessage.allowFrom];
  IMESSAGE_GROUP_ALLOW_FROM = [...config.imessage.groupAllowFrom];
  IMESSAGE_TEXT_CHUNK_LIMIT = Math.max(
    200,
    Math.min(4_000, config.imessage.textChunkLimit),
  );
  IMESSAGE_DEBOUNCE_MS = Math.max(0, config.imessage.debounceMs);
  IMESSAGE_MEDIA_MAX_MB = Math.max(1, config.imessage.mediaMaxMb);
  EMAIL_ENABLED = config.email.enabled;
  EMAIL_IMAP_HOST = config.email.imapHost;
  EMAIL_IMAP_PORT = Math.max(1, Math.min(65_535, config.email.imapPort));
  EMAIL_IMAP_SECURE = config.email.imapSecure;
  EMAIL_SMTP_HOST = config.email.smtpHost;
  EMAIL_SMTP_PORT = Math.max(1, Math.min(65_535, config.email.smtpPort));
  EMAIL_SMTP_SECURE = config.email.smtpSecure;
  EMAIL_ADDRESS = config.email.address;
  EMAIL_PASSWORD =
    readRuntimeSecretValue(
      ['EMAIL_PASSWORD'],
      'EMAIL_PASSWORD',
      storedSecrets,
    ) || config.email.password;
  EMAIL_POLL_INTERVAL_MS = Math.max(1_000, config.email.pollIntervalMs);
  EMAIL_FOLDERS = [...config.email.folders];
  EMAIL_ALLOW_FROM = [...config.email.allowFrom];
  EMAIL_TEXT_CHUNK_LIMIT = Math.max(
    500,
    Math.min(200_000, config.email.textChunkLimit),
  );
  EMAIL_MEDIA_MAX_MB = Math.max(1, config.email.mediaMaxMb);

  HYBRIDAI_BASE_URL = normalizeConfiguredBaseUrl(
    process.env.HYBRIDAI_BASE_URL,
    config.hybridai.baseUrl,
  );
  HYBRIDAI_MODEL = config.hybridai.defaultModel;
  HYBRIDAI_CHATBOT_ID =
    process.env.HYBRIDAI_CHATBOT_ID?.trim() ||
    '' ||
    config.hybridai.defaultChatbotId;
  HYBRIDAI_MAX_TOKENS = Math.max(
    256,
    Math.min(32_768, config.hybridai.maxTokens),
  );
  HYBRIDAI_ENABLE_RAG = config.hybridai.enableRag;
  CODEX_BASE_URL = config.codex.baseUrl;
  ANTHROPIC_ENABLED = config.anthropic.enabled;
  ANTHROPIC_BASE_URL = config.anthropic.baseUrl;
  ANTHROPIC_METHOD = config.anthropic.method;
  OPENROUTER_ENABLED = config.openrouter.enabled;
  OPENROUTER_BASE_URL = config.openrouter.baseUrl;
  MISTRAL_ENABLED = config.mistral.enabled;
  MISTRAL_BASE_URL = config.mistral.baseUrl;
  ANTHROPIC_ENABLED = config.anthropic.enabled;
  ANTHROPIC_BASE_URL = config.anthropic.baseUrl;
  HUGGINGFACE_ENABLED = config.huggingface.enabled;
  HUGGINGFACE_BASE_URL = config.huggingface.baseUrl;
  GEMINI_ENABLED = config.gemini.enabled;
  GEMINI_BASE_URL = config.gemini.baseUrl;
  DEEPSEEK_ENABLED = config.deepseek.enabled;
  DEEPSEEK_BASE_URL = config.deepseek.baseUrl;
  XAI_ENABLED = config.xai.enabled;
  XAI_BASE_URL = config.xai.baseUrl;
  ZAI_ENABLED = config.zai.enabled;
  ZAI_BASE_URL = config.zai.baseUrl;
  KIMI_ENABLED = config.kimi.enabled;
  KIMI_BASE_URL = config.kimi.baseUrl;
  MINIMAX_ENABLED = config.minimax.enabled;
  MINIMAX_BASE_URL = config.minimax.baseUrl;
  DASHSCOPE_ENABLED = config.dashscope.enabled;
  DASHSCOPE_BASE_URL = config.dashscope.baseUrl;
  XIAOMI_ENABLED = config.xiaomi.enabled;
  XIAOMI_BASE_URL = config.xiaomi.baseUrl;
  KILO_ENABLED = config.kilo.enabled;
  KILO_BASE_URL = config.kilo.baseUrl;
  LOCAL_OLLAMA_ENABLED = config.local.backends.ollama.enabled;
  LOCAL_OLLAMA_BASE_URL = config.local.backends.ollama.baseUrl;
  LOCAL_LMSTUDIO_ENABLED = config.local.backends.lmstudio.enabled;
  LOCAL_LMSTUDIO_BASE_URL = config.local.backends.lmstudio.baseUrl;
  LOCAL_LLAMACPP_ENABLED = config.local.backends.llamacpp.enabled;
  LOCAL_LLAMACPP_BASE_URL = config.local.backends.llamacpp.baseUrl;
  LOCAL_VLLM_ENABLED = config.local.backends.vllm.enabled;
  LOCAL_VLLM_BASE_URL = config.local.backends.vllm.baseUrl;
  LOCAL_VLLM_API_KEY = config.local.backends.vllm.apiKey || '';
  LOCAL_DISCOVERY_ENABLED = config.local.discovery.enabled;
  LOCAL_DISCOVERY_INTERVAL_MS = config.local.discovery.intervalMs;
  LOCAL_DISCOVERY_MAX_MODELS = config.local.discovery.maxModels;
  LOCAL_DISCOVERY_CONCURRENCY = config.local.discovery.concurrency;
  LOCAL_HEALTH_CHECK_ENABLED = config.local.healthCheck.enabled;
  LOCAL_HEALTH_CHECK_INTERVAL_MS = config.local.healthCheck.intervalMs;
  LOCAL_HEALTH_CHECK_TIMEOUT_MS = config.local.healthCheck.timeoutMs;
  LOCAL_DEFAULT_CONTEXT_WINDOW = config.local.defaultContextWindow;
  LOCAL_DEFAULT_MAX_TOKENS = config.local.defaultMaxTokens;

  CONTAINER_SANDBOX_MODE = resolveSandboxMode(config);
  CONTAINER_IMAGE = config.container.image;
  CONTAINER_MEMORY = config.container.memory;
  CONTAINER_MEMORY_SWAP = config.container.memorySwap;
  CONTAINER_CPUS = config.container.cpus;
  CONTAINER_NETWORK = config.container.network;
  CONTAINER_TIMEOUT = config.container.timeoutMs;
  CONTAINER_BINDS = config.container.binds;
  ADDITIONAL_MOUNTS = config.container.additionalMounts;
  CONTAINER_MAX_OUTPUT_SIZE = config.container.maxOutputBytes;
  MAX_CONCURRENT_CONTAINERS = Math.max(1, config.container.maxConcurrent);
  CONTAINER_PERSIST_BASH_STATE = config.container.persistBashState;
  MCP_SERVERS = structuredClone(config.mcpServers || {});
  WEB_SEARCH_PROVIDER = config.web.search.provider;
  WEB_SEARCH_FALLBACK_PROVIDERS = [...config.web.search.fallbackProviders];
  WEB_SEARCH_DEFAULT_COUNT = Math.max(
    1,
    Math.min(10, config.web.search.defaultCount),
  );
  WEB_SEARCH_CACHE_TTL_MINUTES = Math.max(
    1,
    Math.min(60, config.web.search.cacheTtlMinutes),
  );
  WEB_SEARCH_SEARXNG_BASE_URL =
    process.env.SEARXNG_BASE_URL || config.web.search.searxngBaseUrl;
  WEB_SEARCH_TAVILY_SEARCH_DEPTH = config.web.search.tavilySearchDepth;

  HEARTBEAT_ENABLED = config.heartbeat.enabled;
  HEARTBEAT_INTERVAL = config.heartbeat.intervalMs;
  HEARTBEAT_CHANNEL = config.heartbeat.channel;
  MEMORY_DECAY_RATE = config.memory.decayRate;
  MEMORY_CONSOLIDATION_INTERVAL_HOURS =
    config.memory.consolidationIntervalHours;

  HEALTH_HOST = process.env.HEALTH_HOST || config.ops.healthHost;
  HEALTH_PORT = config.ops.healthPort;
  WEB_API_TOKEN =
    readRuntimeSecretValue(['WEB_API_TOKEN'], 'WEB_API_TOKEN', storedSecrets) ||
    config.ops.webApiToken;
  GATEWAY_BASE_URL = config.ops.gatewayBaseUrl;
  GATEWAY_API_TOKEN =
    readRuntimeSecretValue(
      ['GATEWAY_API_TOKEN'],
      'GATEWAY_API_TOKEN',
      storedSecrets,
    ) ||
    config.ops.gatewayApiToken ||
    WEB_API_TOKEN ||
    // Persist the generated fallback so separately launched local clients can
    // authenticate to this gateway. Deleting credentials while the gateway is
    // already running can still require a gateway restart to repersist the token.
    getOrPersistGatewayApiToken();
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
  const normalizedContextGuard = normalizeContextGuardConfig(
    config.sessionCompaction.inLoopGuard,
    CONTEXT_GUARD_DEFAULTS,
  );
  CONTEXT_GUARD_ENABLED = normalizedContextGuard.enabled;
  CONTEXT_GUARD_PER_RESULT_SHARE = normalizedContextGuard.perResultShare;
  CONTEXT_GUARD_COMPACTION_RATIO = normalizedContextGuard.compactionRatio;
  CONTEXT_GUARD_OVERFLOW_RATIO = normalizedContextGuard.overflowRatio;
  CONTEXT_GUARD_MAX_RETRIES = normalizedContextGuard.maxRetries;

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
  PROACTIVE_DELEGATION_MODEL = config.proactive.delegation.model.trim();
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
