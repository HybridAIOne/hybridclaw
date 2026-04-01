import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';

const RUNTIME_SECRETS_FILE = 'credentials.json';
const RUNTIME_MASTER_KEY_FILE = 'credentials.master.key';
const RUNTIME_MASTER_KEY_SECRET_PATH = '/run/secrets/hybridclaw_master_key';
const SECRET_STORE_VERSION = 1;
const SECRET_STORE_ALGORITHM = 'aes-256-gcm';
const SECRET_STORE_NONCE_BYTES = 12;
const SECRET_STORE_TAG_BYTES = 16;
const RUNTIME_HOME_MODE = 0o700;
const RUNTIME_SECRETS_MODE = 0o600;

const SECRET_KEYS = [
  'HYBRIDAI_API_KEY',
  'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY',
  'HF_TOKEN',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'DEEPGRAM_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'VLLM_API_KEY',
  'DISCORD_TOKEN',
  'EMAIL_PASSWORD',
  'IMESSAGE_PASSWORD',
  'MSTEAMS_APP_PASSWORD',
  'WEB_API_TOKEN',
  'GATEWAY_API_TOKEN',
] as const;

const NON_SECRET_RUNTIME_CONFIG_KEYS = [
  'HYBRIDAI_BASE_URL',
  'HYBRIDAI_MODEL',
  'HYBRIDAI_CHATBOT_ID',
  'CONTAINER_IMAGE',
  'CONTAINER_MEMORY',
  'CONTAINER_CPUS',
  'CONTAINER_TIMEOUT',
  'DISCORD_PREFIX',
  'HEALTH_PORT',
  'LOG_LEVEL',
  'DB_PATH',
] as const;

export type RuntimeSecretKey = (typeof SECRET_KEYS)[number];
export type RuntimeSecretName = string;
type RuntimeSecrets = Record<string, string>;
const RUNTIME_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

export function isRuntimeSecretKey(value: string): value is RuntimeSecretKey {
  return SECRET_KEYS.includes(value as RuntimeSecretKey);
}

export function isRuntimeSecretName(value: string): value is RuntimeSecretName {
  return RUNTIME_SECRET_NAME_RE.test(String(value || '').trim());
}

export function isReservedNonSecretRuntimeName(value: string): boolean {
  return NON_SECRET_RUNTIME_CONFIG_KEYS.includes(
    String(
      value || '',
    ).trim() as (typeof NON_SECRET_RUNTIME_CONFIG_KEYS)[number],
  );
}

function isPersistableRuntimeSecretName(
  value: string,
): value is RuntimeSecretName {
  return isRuntimeSecretName(value) && !isReservedNonSecretRuntimeName(value);
}

function sanitizeRuntimeSecrets(
  record: Record<string, unknown>,
): RuntimeSecrets {
  const secrets: RuntimeSecrets = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isPersistableRuntimeSecretName(key)) continue;
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) secrets[key] = normalized;
  }
  return secrets;
}

interface EncryptedSecretEntry {
  alg: typeof SECRET_STORE_ALGORITHM;
  nonce: string;
  ciphertext: string;
}

interface EncryptedSecretStore {
  version: typeof SECRET_STORE_VERSION;
  entries: Record<string, EncryptedSecretEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isEncryptedSecretEntry(value: unknown): value is EncryptedSecretEntry {
  return (
    isRecord(value) &&
    value.alg === SECRET_STORE_ALGORITHM &&
    typeof value.nonce === 'string' &&
    typeof value.ciphertext === 'string'
  );
}

function isEncryptedSecretStore(value: unknown): value is EncryptedSecretStore {
  if (!isRecord(value)) return false;
  if (value.version !== SECRET_STORE_VERSION) return false;
  if (!isRecord(value.entries)) return false;

  for (const [secretKey, entry] of Object.entries(value.entries)) {
    if (!isRuntimeSecretName(secretKey)) return false;
    if (!isEncryptedSecretEntry(entry)) return false;
  }

  return true;
}

function ensureExistingRuntimeHomePermissions(): void {
  if (!fs.existsSync(DEFAULT_RUNTIME_HOME_DIR)) return;
  fs.chmodSync(DEFAULT_RUNTIME_HOME_DIR, RUNTIME_HOME_MODE);
}

function ensureRuntimeHomeDir(): void {
  fs.mkdirSync(DEFAULT_RUNTIME_HOME_DIR, {
    recursive: true,
    mode: RUNTIME_HOME_MODE,
  });
  fs.chmodSync(DEFAULT_RUNTIME_HOME_DIR, RUNTIME_HOME_MODE);
}

function normalizeSecretMap(record: Record<string, unknown>): RuntimeSecrets {
  return sanitizeRuntimeSecrets(record);
}

function runtimeMasterKeyPath(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, RUNTIME_MASTER_KEY_FILE);
}

function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('master key source is empty');
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // fall through
  }
  return createHash('sha256').update(trimmed, 'utf-8').digest();
}

function readMasterKeyFile(filePath: string): Buffer | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseMasterKey(raw);
}

function resolveMasterKey(options?: { allowCreateLocalFallback?: boolean }): {
  key: Buffer;
  source: 'env' | 'mounted-secret' | 'local-file';
} {
  const envKey = (process.env.HYBRIDCLAW_MASTER_KEY || '').trim();
  if (envKey) {
    return {
      key: parseMasterKey(envKey),
      source: 'env',
    };
  }

  const mountedKey = readMasterKeyFile(RUNTIME_MASTER_KEY_SECRET_PATH);
  if (mountedKey) {
    return {
      key: mountedKey,
      source: 'mounted-secret',
    };
  }

  const localKeyPath = runtimeMasterKeyPath();
  const localKey = readMasterKeyFile(localKeyPath);
  if (localKey) {
    return {
      key: localKey,
      source: 'local-file',
    };
  }

  if (!options?.allowCreateLocalFallback) {
    throw new Error(
      `no master key available; set HYBRIDCLAW_MASTER_KEY, mount ${RUNTIME_MASTER_KEY_SECRET_PATH}, or restore ${localKeyPath}`,
    );
  }

  ensureRuntimeHomeDir();
  const generated = randomBytes(32).toString('base64');
  fs.writeFileSync(localKeyPath, `${generated}\n`, {
    encoding: 'utf-8',
    mode: RUNTIME_SECRETS_MODE,
  });
  fs.chmodSync(localKeyPath, RUNTIME_SECRETS_MODE);
  return {
    key: Buffer.from(generated, 'base64'),
    source: 'local-file',
  };
}

function encryptSecretValue(
  key: Buffer,
  secretKey: string,
  value: string,
): EncryptedSecretEntry {
  const nonce = randomBytes(SECRET_STORE_NONCE_BYTES);
  const cipher = createCipheriv(SECRET_STORE_ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(secretKey, 'utf-8'));
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf-8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    alg: SECRET_STORE_ALGORITHM,
    nonce: nonce.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptSecretValue(
  key: Buffer,
  secretKey: string,
  entry: EncryptedSecretEntry,
): string {
  const nonce = Buffer.from(entry.nonce, 'base64');
  const payload = Buffer.from(entry.ciphertext, 'base64');
  if (payload.length < SECRET_STORE_TAG_BYTES) {
    throw new Error(`stored ${secretKey} ciphertext is truncated`);
  }
  const ciphertext = payload.subarray(0, -SECRET_STORE_TAG_BYTES);
  const authTag = payload.subarray(-SECRET_STORE_TAG_BYTES);
  const decipher = createDecipheriv(SECRET_STORE_ALGORITHM, key, nonce);
  decipher.setAAD(Buffer.from(secretKey, 'utf-8'));
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf-8');
}

class SecretStore {
  readonly filePath = runtimeSecretsPath();

  readAll(): RuntimeSecrets {
    ensureExistingRuntimeHomePermissions();
    if (!fs.existsSync(this.filePath)) return {};

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;

      if (isEncryptedSecretStore(parsed)) {
        const { key } = resolveMasterKey();
        const secrets: RuntimeSecrets = {};
        for (const [secretKey, entry] of Object.entries(parsed.entries)) {
          if (!entry) continue;
          const decrypted = decryptSecretValue(key, secretKey, entry).trim();
          if (!decrypted) continue;
          secrets[secretKey] = decrypted;
        }
        return secrets;
      }

      if (!isRecord(parsed)) {
        return {};
      }

      const plaintextSecrets = normalizeSecretMap(parsed);
      console.info(`Migrating plaintext runtime secrets to ${this.filePath}`);
      try {
        this.writeAll(plaintextSecrets);
      } catch (err) {
        console.warn(
          `[runtime-secrets] failed to migrate legacy plaintext credentials at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return plaintextSecrets;
    } catch (err) {
      console.warn(
        `[runtime-secrets] failed to read ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  }

  writeAll(secrets: RuntimeSecrets): void {
    const sanitizedSecrets = sanitizeRuntimeSecrets(secrets);
    ensureRuntimeHomeDir();

    if (Object.keys(sanitizedSecrets).length === 0) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }

    const { key } = resolveMasterKey({ allowCreateLocalFallback: true });
    const entries: EncryptedSecretStore['entries'] = {};
    for (const [secretKey, value] of Object.entries(sanitizedSecrets)) {
      entries[secretKey] = encryptSecretValue(key, secretKey, value);
    }

    const payload: EncryptedSecretStore = {
      version: SECRET_STORE_VERSION,
      entries,
    };

    fs.writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: RUNTIME_SECRETS_MODE,
    });
    fs.chmodSync(this.filePath, RUNTIME_SECRETS_MODE);
  }
}

function parseEnvStyleSecrets(content: string): RuntimeSecrets {
  const secrets: RuntimeSecrets = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (!isPersistableRuntimeSecretName(key)) continue;

    let value = trimmed.slice(eqIdx + 1).trim();
    if (!value) continue;

    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hashIdx = value.indexOf('#');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    } else if (value.length >= 2) {
      value = value.slice(1, -1);
    }

    if (!value) continue;
    secrets[key] = value;
  }

  return secrets;
}

function readLegacyEnvSecrets(cwd: string = process.cwd()): RuntimeSecrets {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return {};

  try {
    return parseEnvStyleSecrets(fs.readFileSync(envPath, 'utf-8'));
  } catch (err) {
    console.warn(
      `[runtime-secrets] failed to read ${envPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

export function runtimeSecretsPath(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, RUNTIME_SECRETS_FILE);
}

export function readStoredRuntimeSecret(
  secretKey: RuntimeSecretName,
): string | null {
  if (!isRuntimeSecretName(secretKey)) return null;
  const store = new SecretStore();
  const value = store.readAll()[secretKey];
  return value?.trim() || null;
}

export function listStoredRuntimeSecretNames(): string[] {
  const store = new SecretStore();
  return Object.keys(store.readAll()).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function loadRuntimeSecrets(cwd: string = process.cwd()): void {
  const store = new SecretStore();
  const secrets = store.readAll();
  const legacySecrets = readLegacyEnvSecrets(cwd);
  const migratedSecrets: RuntimeSecrets = {};

  for (const key of SECRET_KEYS) {
    if (secrets[key] || !legacySecrets[key]) continue;
    migratedSecrets[key] = legacySecrets[key];
  }

  if (Object.keys(migratedSecrets).length > 0) {
    const destination = runtimeSecretsPath();
    console.info(`Migrating .env to ${destination}`);
    try {
      store.writeAll({ ...secrets, ...migratedSecrets });
    } catch (err) {
      console.warn(
        `[runtime-secrets] failed to migrate legacy .env secrets to ${destination}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function saveRuntimeSecrets(
  updates: Partial<Record<RuntimeSecretKey, string | null>>,
): string {
  return saveNamedRuntimeSecrets(updates);
}

export function saveNamedRuntimeSecrets(
  updates: Partial<Record<string, string | null>>,
): string {
  const filePath = runtimeSecretsPath();
  const store = new SecretStore();
  const next = store.readAll();

  for (const [key, value] of Object.entries(updates)) {
    if (!isRuntimeSecretName(key)) {
      throw new Error(
        `Invalid secret name "${key}". Use uppercase letters, digits, and underscores only.`,
      );
    }
    if (isReservedNonSecretRuntimeName(key)) {
      throw new Error(
        `Secret name "${key}" is reserved for non-secret runtime config and cannot be stored in credentials.json.`,
      );
    }
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      next[key] = normalized;
    } else {
      delete next[key];
    }
  }

  store.writeAll(next);
  return filePath;
}
