import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';

const RUNTIME_SECRETS_FILE = 'credentials.json';

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
  'DISCORD_TOKEN',
  'EMAIL_PASSWORD',
  'IMESSAGE_PASSWORD',
  'MSTEAMS_APP_PASSWORD',
  'WEB_API_TOKEN',
  'GATEWAY_API_TOKEN',
] as const;

export type RuntimeSecretKey = (typeof SECRET_KEYS)[number];
type RuntimeSecrets = Partial<Record<RuntimeSecretKey, string>>;
const runtimeSecretManagedKeys = new Set<RuntimeSecretKey>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readRuntimeSecrets(): RuntimeSecrets {
  const filePath = runtimeSecretsPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};

    const secrets: RuntimeSecrets = {};
    for (const key of SECRET_KEYS) {
      const value = parsed[key];
      if (typeof value !== 'string') continue;
      const normalized = value.trim();
      if (normalized) secrets[key] = normalized;
    }
    return secrets;
  } catch (err) {
    console.warn(
      `[runtime-secrets] failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

function parseEnvStyleSecrets(content: string): RuntimeSecrets {
  const secrets: RuntimeSecrets = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim() as RuntimeSecretKey;
    if (!SECRET_KEYS.includes(key)) continue;

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

export function loadRuntimeSecrets(cwd: string = process.cwd()): void {
  const secrets = readRuntimeSecrets();
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
      saveRuntimeSecrets(migratedSecrets);
    } catch (err) {
      console.warn(
        `[runtime-secrets] failed to migrate legacy .env secrets to ${destination}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const key of SECRET_KEYS) {
    const value = secrets[key] || migratedSecrets[key] || '';
    const currentValue = process.env[key] || '';
    const managed = runtimeSecretManagedKeys.has(key);

    if (value) {
      if (!currentValue || managed) {
        process.env[key] = value;
        runtimeSecretManagedKeys.add(key);
      }
      continue;
    }

    if (managed) {
      delete process.env[key];
      runtimeSecretManagedKeys.delete(key);
    }
  }
}

export function saveRuntimeSecrets(
  updates: Partial<Record<RuntimeSecretKey, string | null>>,
): string {
  const filePath = runtimeSecretsPath();
  const next = readRuntimeSecrets();

  for (const key of SECRET_KEYS) {
    if (!Object.hasOwn(updates, key)) continue;
    const value = updates[key];
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      next[key] = normalized;
    } else {
      delete next[key];
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (Object.keys(next).length === 0) {
    fs.rmSync(filePath, { force: true });
    return filePath;
  }

  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  // Re-apply owner-only permissions so an existing credentials file is corrected too.
  fs.chmodSync(filePath, 0o600);
  return filePath;
}
