import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { migrateLegacySecretFile } from './runtime-secrets-migration.js';

const RUNTIME_SECRETS_FILE = 'credentials.json';
const RUNTIME_MASTER_KEY_FILE = 'credentials.master.key';
const RUNTIME_MASTER_KEY_SECRET_PATH = '/run/secrets/hybridclaw_master_key';
const RUNTIME_LEGACY_SECRETS_SUFFIX = '.legacy';
const PASSPHRASE_KDF_SALT = 'hybridclaw-master-key-v1';
const SECRET_STORE_VERSION = 1;
const SECRET_STORE_ALGORITHM = 'aes-256-gcm';
const SECRET_STORE_NONCE_BYTES = 12;
const SECRET_STORE_TAG_BYTES = 16;
const RUNTIME_HOME_MODE = 0o700;
const RUNTIME_SECRETS_MODE = 0o600;

const SECRET_KEYS = [
  'HYBRIDAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY',
  'HF_TOKEN',
  'OPENAI_API_KEY',
  'BFL_API_KEY',
  'BLACK_FOREST_LABS_API_KEY',
  'GROQ_API_KEY',
  'DEEPGRAM_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'VLLM_API_KEY',
  'BRAVE_API_KEY',
  'PERPLEXITY_API_KEY',
  'TAVILY_API_KEY',
  'DISCORD_TOKEN',
  'EMAIL_PASSWORD',
  'TELEGRAM_BOT_TOKEN',
  'THREEMA_GATEWAY_SECRET',
  'IMESSAGE_PASSWORD',
  'TWILIO_AUTH_TOKEN',
  'MSTEAMS_APP_PASSWORD',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'WEB_API_TOKEN',
  'GATEWAY_API_TOKEN',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'ZAI_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'DASHSCOPE_API_KEY',
  'XIAOMI_API_KEY',
  'KILO_API_KEY',
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
type RuntimeSecretStoreMetadata = Record<
  string,
  { createdAt: string | null; lastRotatedAt: string | null }
>;
type SecretStoreReadStatus =
  | 'missing'
  | 'encrypted'
  | 'encrypted-unreadable'
  | 'invalid';
const RUNTIME_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

interface SecretStoreReadResult {
  fileSignature: string | null;
  fileModifiedAt: string | null;
  keySourceSignature: string | null;
  metadata: RuntimeSecretStoreMetadata;
  secrets: RuntimeSecrets;
  status: SecretStoreReadStatus;
}

export interface RuntimeSecretFingerprint {
  length: number;
  /** Short display identifier only; not a uniqueness or collision guarantee. */
  sha256_prefix: string;
}

export interface RuntimeSecretMetadataEntry {
  name: string;
  state: 'set' | 'unset';
  created_at: string | null;
  last_rotated_at: string | null;
  length: number | null;
  fingerprint: RuntimeSecretFingerprint | null;
}

let cachedSecretStoreRead: SecretStoreReadResult | null = null;
let runtimeHomePermissionsEnsured = false;

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
  created_at?: string;
  last_rotated_at?: string;
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
    value.nonce.length === 16 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.nonce) &&
    typeof value.ciphertext === 'string' &&
    value.ciphertext.length >= 24 &&
    value.ciphertext.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext)
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
  if (runtimeHomePermissionsEnsured) return;
  if (!fs.existsSync(DEFAULT_RUNTIME_HOME_DIR)) return;
  try {
    fs.chmodSync(DEFAULT_RUNTIME_HOME_DIR, RUNTIME_HOME_MODE);
  } catch (error) {
    console.warn(
      `[runtime-secrets] failed to set permissions on ${DEFAULT_RUNTIME_HOME_DIR}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    runtimeHomePermissionsEnsured = true;
  }
}

function ensureRuntimeHomeDir(): void {
  fs.mkdirSync(DEFAULT_RUNTIME_HOME_DIR, {
    recursive: true,
    mode: RUNTIME_HOME_MODE,
  });
  try {
    fs.chmodSync(DEFAULT_RUNTIME_HOME_DIR, RUNTIME_HOME_MODE);
  } catch (error) {
    console.warn(
      `[runtime-secrets] failed to set permissions on ${DEFAULT_RUNTIME_HOME_DIR}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  runtimeHomePermissionsEnsured = true;
}

function runtimeMasterKeyPath(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, RUNTIME_MASTER_KEY_FILE);
}

export function runtimeLegacySecretsPath(): string {
  return `${runtimeSecretsPath()}${RUNTIME_LEGACY_SECRETS_SUFFIX}`;
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
  return scryptSync(trimmed, PASSPHRASE_KDF_SALT, 32);
}

function readMasterKeyFile(filePath: string): Buffer | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parseMasterKey(raw);
  } catch (error) {
    console.warn(
      `[runtime-secrets] failed to load master key from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function readFileSignature(filePath: string): string | null {
  return readFileMetadata(filePath).signature;
}

function readFileMetadata(filePath: string): {
  modifiedAt: string | null;
  signature: string | null;
} {
  try {
    const stats = fs.statSync(filePath);
    return {
      modifiedAt: new Date(stats.mtimeMs).toISOString(),
      signature: `${stats.size}:${stats.mtimeMs}`,
    };
  } catch {
    return { modifiedAt: null, signature: null };
  }
}

function currentMasterKeySourceSignature(): string {
  const envKey = (process.env.HYBRIDCLAW_MASTER_KEY || '').trim();
  if (envKey) {
    return `env:${createHash('sha256').update(envKey, 'utf-8').digest('hex')}`;
  }

  const mountedSignature = readFileSignature(RUNTIME_MASTER_KEY_SECRET_PATH);
  if (mountedSignature) {
    return `mounted:${mountedSignature}`;
  }

  const localSignature = readFileSignature(runtimeMasterKeyPath());
  if (localSignature) {
    return `local:${localSignature}`;
  }

  return 'none';
}

function cloneRuntimeSecretStoreMetadata(
  metadata: RuntimeSecretStoreMetadata,
): RuntimeSecretStoreMetadata {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      {
        createdAt: value.createdAt,
        lastRotatedAt: value.lastRotatedAt,
      },
    ]),
  );
}

function cacheSecretStoreRead(
  result: SecretStoreReadResult,
): SecretStoreReadResult {
  cachedSecretStoreRead = {
    ...result,
    metadata: cloneRuntimeSecretStoreMetadata(result.metadata),
    secrets: { ...result.secrets },
  };
  return {
    ...result,
    metadata: cloneRuntimeSecretStoreMetadata(result.metadata),
    secrets: { ...result.secrets },
  };
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
      `no master key available; mount ${RUNTIME_MASTER_KEY_SECRET_PATH} or restore ${localKeyPath}`,
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

function decryptEncryptedSecretStore(
  key: Buffer,
  store: EncryptedSecretStore,
): { metadata: RuntimeSecretStoreMetadata; secrets: RuntimeSecrets } {
  const metadata: RuntimeSecretStoreMetadata = {};
  const secrets: RuntimeSecrets = {};
  let decryptFailures = 0;
  let lastDecryptError: Error | null = null;
  for (const [secretKey, entry] of Object.entries(store.entries)) {
    if (!entry) continue;
    metadata[secretKey] = {
      createdAt:
        typeof entry.created_at === 'string' && entry.created_at.trim()
          ? entry.created_at.trim()
          : null,
      lastRotatedAt:
        typeof entry.last_rotated_at === 'string' &&
        entry.last_rotated_at.trim()
          ? entry.last_rotated_at.trim()
          : null,
    };
    let decrypted = '';
    try {
      decrypted = decryptSecretValue(key, secretKey, entry).trim();
    } catch (error) {
      decryptFailures += 1;
      lastDecryptError =
        error instanceof Error ? error : new Error(String(error));
      console.warn(
        `[runtime-secrets] failed to decrypt stored ${secretKey}: ${lastDecryptError.message}`,
      );
      continue;
    }
    if (!decrypted) continue;
    secrets[secretKey] = decrypted;
  }
  if (
    decryptFailures > 0 &&
    Object.keys(secrets).length === 0 &&
    Object.keys(store.entries).length > 0
  ) {
    throw lastDecryptError || new Error('failed to decrypt encrypted store');
  }
  return { metadata, secrets };
}

function buildEncryptedSecretStore(
  key: Buffer,
  secrets: RuntimeSecrets,
  previous: {
    metadata: RuntimeSecretStoreMetadata;
    secrets: RuntimeSecrets;
  },
  now: string,
): EncryptedSecretStore {
  const entries: EncryptedSecretStore['entries'] = {};
  for (const [secretKey, value] of Object.entries(secrets)) {
    const previousMetadata = previous.metadata[secretKey];
    const previousValue = previous.secrets[secretKey] || '';
    const valueUnchanged = previousValue === value;
    const createdAt = previousMetadata?.createdAt || now;
    const lastRotatedAt =
      valueUnchanged && previousMetadata?.lastRotatedAt
        ? previousMetadata.lastRotatedAt
        : now;
    entries[secretKey] = {
      ...encryptSecretValue(key, secretKey, value),
      created_at: createdAt,
      last_rotated_at: lastRotatedAt,
    };
  }
  return {
    version: SECRET_STORE_VERSION,
    entries,
  };
}

function writeTextFileSynced(
  filePath: string,
  content: string,
  mode: number,
): void {
  const fd = fs.openSync(filePath, 'w', mode);
  try {
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, mode);
}

function writeEncryptedSecretStoreFile(
  filePath: string,
  payload: EncryptedSecretStore,
): void {
  writeTextFileSynced(
    filePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    RUNTIME_SECRETS_MODE,
  );
}

function writeEncryptedSecretStoreFileAtomically(
  filePath: string,
  payload: EncryptedSecretStore,
): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  try {
    writeEncryptedSecretStoreFile(tempPath, payload);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function readEncryptedSecretStoreFile(
  filePath: string,
  key: Buffer,
): RuntimeSecrets {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  if (!isEncryptedSecretStore(parsed)) {
    throw new Error(`expected encrypted secret store at ${filePath}`);
  }
  return decryptEncryptedSecretStore(key, parsed).secrets;
}

function haveEqualRuntimeSecrets(
  left: RuntimeSecrets,
  right: RuntimeSecrets,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(
    ([leftKey, leftValue], index) =>
      leftKey === rightEntries[index]?.[0] &&
      leftValue === rightEntries[index]?.[1],
  );
}

class SecretStore {
  readonly filePath = runtimeSecretsPath();

  readAllResult(): SecretStoreReadResult {
    ensureExistingRuntimeHomePermissions();
    const fileMetadata = readFileMetadata(this.filePath);
    const fileSignature = fileMetadata.signature;
    const fileModifiedAt = fileMetadata.modifiedAt;
    const keySourceSignature = currentMasterKeySourceSignature();
    if (!fileSignature) {
      return cacheSecretStoreRead({
        fileSignature: null,
        fileModifiedAt: null,
        keySourceSignature: null,
        metadata: {},
        secrets: {},
        status: 'missing',
      });
    }

    if (
      cachedSecretStoreRead?.fileSignature === fileSignature &&
      cachedSecretStoreRead.keySourceSignature === keySourceSignature
    ) {
      return {
        ...cachedSecretStoreRead,
        metadata: cloneRuntimeSecretStoreMetadata(
          cachedSecretStoreRead.metadata,
        ),
        secrets: { ...cachedSecretStoreRead.secrets },
      };
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;

      if (isEncryptedSecretStore(parsed)) {
        try {
          const { key } = resolveMasterKey();
          const { metadata, secrets } = decryptEncryptedSecretStore(
            key,
            parsed,
          );
          return cacheSecretStoreRead({
            fileSignature,
            fileModifiedAt,
            keySourceSignature,
            metadata,
            secrets,
            status: 'encrypted',
          });
        } catch (error) {
          console.warn(
            `[runtime-secrets] failed to decrypt ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return cacheSecretStoreRead({
            fileSignature,
            fileModifiedAt,
            keySourceSignature,
            metadata: {},
            secrets: {},
            status: 'encrypted-unreadable',
          });
        }
      }

      return cacheSecretStoreRead({
        fileSignature,
        fileModifiedAt,
        keySourceSignature: null,
        metadata: {},
        secrets: {},
        status: 'invalid',
      });
    } catch (err) {
      console.warn(
        `[runtime-secrets] failed to read ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return cacheSecretStoreRead({
        fileSignature,
        fileModifiedAt,
        keySourceSignature: null,
        metadata: {},
        secrets: {},
        status: 'invalid',
      });
    }
  }

  readAll(): RuntimeSecrets {
    return this.readAllResult().secrets;
  }

  migrateLegacyPlaintextFile(secrets: RuntimeSecrets): void {
    const sanitizedSecrets = sanitizeRuntimeSecrets(secrets);
    if (Object.keys(sanitizedSecrets).length === 0) {
      return;
    }

    ensureRuntimeHomeDir();
    const legacyPath = runtimeLegacySecretsPath();
    const { key } = resolveMasterKey({ allowCreateLocalFallback: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    const payload = buildEncryptedSecretStore(
      key,
      sanitizedSecrets,
      { metadata: {}, secrets: {} },
      now,
    );

    migrateLegacySecretFile({
      filePath: this.filePath,
      legacyPath,
      tempPath,
      expectedSecrets: sanitizedSecrets,
      writeTempFile: (targetPath) =>
        writeEncryptedSecretStoreFile(targetPath, payload),
      validateFinalFile: (targetPath) =>
        readEncryptedSecretStoreFile(targetPath, key),
      areEqual: haveEqualRuntimeSecrets,
      onValidated: () => {
        const fileMetadata = readFileMetadata(this.filePath);
        cachedSecretStoreRead = {
          fileSignature: fileMetadata.signature,
          fileModifiedAt: fileMetadata.modifiedAt,
          keySourceSignature: currentMasterKeySourceSignature(),
          metadata: Object.fromEntries(
            Object.keys(sanitizedSecrets).map((secretKey) => [
              secretKey,
              { createdAt: now, lastRotatedAt: now },
            ]),
          ),
          secrets: { ...sanitizedSecrets },
          status: 'encrypted',
        };
      },
      onValidatedBackupRemovalError: (error) => {
        console.warn(
          `[runtime-secrets] failed to remove validated legacy backup ${legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  }

  writeAll(secrets: RuntimeSecrets): void {
    const sanitizedSecrets = sanitizeRuntimeSecrets(secrets);
    const previous = this.readAllResult();
    ensureRuntimeHomeDir();

    if (Object.keys(sanitizedSecrets).length === 0) {
      fs.rmSync(this.filePath, { force: true });
      cachedSecretStoreRead = {
        fileSignature: null,
        fileModifiedAt: null,
        keySourceSignature: null,
        metadata: {},
        secrets: {},
        status: 'missing',
      };
      return;
    }

    const { key } = resolveMasterKey({ allowCreateLocalFallback: true });
    const payload = buildEncryptedSecretStore(
      key,
      sanitizedSecrets,
      {
        metadata: previous.metadata,
        secrets: previous.secrets,
      },
      new Date().toISOString(),
    );
    writeEncryptedSecretStoreFileAtomically(this.filePath, payload);
    const metadata = Object.fromEntries(
      Object.entries(payload.entries).map(([secretKey, entry]) => [
        secretKey,
        {
          createdAt: entry.created_at || null,
          lastRotatedAt: entry.last_rotated_at || null,
        },
      ]),
    );
    const fileMetadata = readFileMetadata(this.filePath);
    cachedSecretStoreRead = {
      fileSignature: fileMetadata.signature,
      fileModifiedAt: fileMetadata.modifiedAt,
      keySourceSignature: currentMasterKeySourceSignature(),
      metadata,
      secrets: { ...sanitizedSecrets },
      status: 'encrypted',
    };
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
  const value = readStoredRuntimeSecrets()[secretKey];
  return value?.trim() || null;
}

export function readStoredRuntimeSecrets(): RuntimeSecrets {
  const store = new SecretStore();
  return { ...store.readAll() };
}

export function migrateLegacyRuntimeSecretsFile(): boolean {
  const store = new SecretStore();
  const filePath = runtimeSecretsPath();
  if (!fs.existsSync(filePath)) return false;
  const status = store.readAllResult().status;
  if (
    status === 'encrypted' ||
    status === 'encrypted-unreadable' ||
    status === 'missing'
  ) {
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (isEncryptedSecretStore(parsed) || !isRecord(parsed)) {
      return false;
    }

    const plaintextSecrets = sanitizeRuntimeSecrets(parsed);
    if (Object.keys(plaintextSecrets).length === 0) {
      return false;
    }

    console.info(`Migrating plaintext runtime secrets to ${filePath}`);
    store.migrateLegacyPlaintextFile(plaintextSecrets);
    return true;
  } catch (err) {
    console.warn(
      `[runtime-secrets] failed to migrate legacy plaintext credentials at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export function listStoredRuntimeSecretNames(): string[] {
  return Object.keys(readStoredRuntimeSecrets()).sort((left, right) =>
    left.localeCompare(right),
  );
}

function fingerprintRuntimeSecretValue(
  value: string,
): RuntimeSecretFingerprint {
  return {
    length: Buffer.byteLength(value, 'utf-8'),
    sha256_prefix: createHash('sha256')
      .update(value, 'utf-8')
      .digest('hex')
      .slice(0, 12),
  };
}

export function listRuntimeSecretMetadata(options?: {
  declaredNames?: string[];
}): RuntimeSecretMetadataEntry[] {
  const store = new SecretStore();
  const result = store.readAllResult();
  const declaredNames = new Set<string>([
    ...SECRET_KEYS,
    ...(options?.declaredNames || []).filter(isRuntimeSecretName),
    ...Object.keys(result.metadata),
    ...Object.keys(result.secrets),
  ]);

  return [...declaredNames]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const value = result.secrets[name] || '';
      const metadata = result.metadata[name];
      const fallbackTimestamp = result.fileModifiedAt;
      const createdAt = value ? metadata?.createdAt || fallbackTimestamp : null;
      const lastRotatedAt = value
        ? metadata?.lastRotatedAt || metadata?.createdAt || fallbackTimestamp
        : null;
      const fingerprint = value ? fingerprintRuntimeSecretValue(value) : null;
      return {
        name,
        state: value ? 'set' : 'unset',
        created_at: createdAt,
        last_rotated_at: lastRotatedAt,
        length: fingerprint?.length ?? null,
        fingerprint,
      };
    });
}

export function loadRuntimeSecrets(cwd: string = process.cwd()): void {
  const store = new SecretStore();
  const { secrets, status } = store.readAllResult();
  if (status === 'encrypted-unreadable') {
    return;
  }
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
