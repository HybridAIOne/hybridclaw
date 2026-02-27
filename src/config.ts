import fs from 'fs';
import os from 'os';
import path from 'path';

function loadEnvFile(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip inline comments (# ...) unless the value is quoted
    if (!val.startsWith('"') && !val.startsWith("'")) {
      const hashIdx = val.indexOf('#');
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    } else {
      // Remove surrounding quotes
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnvFile();

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// Discord (optional for TUI mode)
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
export const DISCORD_PREFIX = process.env.DISCORD_PREFIX || '!claw';

// HybridAI
export const HYBRIDAI_API_KEY = required('HYBRIDAI_API_KEY');
export const HYBRIDAI_BASE_URL = process.env.HYBRIDAI_BASE_URL || 'https://hybridai.one';
export const HYBRIDAI_MODEL = process.env.HYBRIDAI_MODEL || 'gpt-5-nano';
export const HYBRIDAI_CHATBOT_ID = process.env.HYBRIDAI_CHATBOT_ID || '';
export const HYBRIDAI_ENABLE_RAG = process.env.HYBRIDAI_ENABLE_RAG !== 'false';
export const HYBRIDAI_MODELS: string[] = process.env.HYBRIDAI_MODELS
  ? process.env.HYBRIDAI_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
  : ['gpt-5-nano', 'gpt-5-mini', 'gpt-5'];

// Container
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'hybridclaw-agent';
export const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY || '512m';
export const CONTAINER_CPUS = process.env.CONTAINER_CPUS || '1';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '60000', 10);

// Mounts
export const MOUNT_ALLOWLIST_PATH = path.join(
  os.homedir(), '.config', 'hybridclaw', 'mount-allowlist.json',
);
export const ADDITIONAL_MOUNTS = process.env.ADDITIONAL_MOUNTS || '';

// Security / limits
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10,
); // 10 MB
export const MAX_CONCURRENT_CONTAINERS = Math.max(1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// Heartbeat
export const HEARTBEAT_ENABLED = process.env.HEARTBEAT_ENABLED !== 'false';
export const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '1800000', 10);
export const HEARTBEAT_CHANNEL = process.env.HEARTBEAT_CHANNEL || '';

// Ops
export const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '9090', 10);
export const DB_PATH = process.env.DB_PATH || 'data/hybridclaw.db';
export const DATA_DIR = path.dirname(DB_PATH);

// Session compaction / memory flush
export const SESSION_COMPACTION_ENABLED = process.env.SESSION_COMPACTION_ENABLED !== 'false';
export const SESSION_COMPACTION_THRESHOLD = Math.max(
  20,
  parseInt(process.env.SESSION_COMPACTION_THRESHOLD || '120', 10) || 120,
);
export const SESSION_COMPACTION_KEEP_RECENT = Math.max(
  10,
  parseInt(process.env.SESSION_COMPACTION_KEEP_RECENT || '40', 10) || 40,
);
export const SESSION_COMPACTION_SUMMARY_MAX_CHARS = Math.max(
  1_000,
  parseInt(process.env.SESSION_COMPACTION_SUMMARY_MAX_CHARS || '8000', 10) || 8000,
);
export const PRE_COMPACTION_MEMORY_FLUSH_ENABLED =
  process.env.PRE_COMPACTION_MEMORY_FLUSH_ENABLED !== 'false';
export const PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES = Math.max(
  8,
  parseInt(process.env.PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES || '80', 10) || 80,
);
export const PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS = Math.max(
  4_000,
  parseInt(process.env.PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS || '24000', 10) || 24000,
);
