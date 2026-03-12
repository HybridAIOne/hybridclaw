import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNTIME_SECRETS_FILE = 'credentials.json';

const SECRET_KEYS = [
  'HYBRIDAI_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'DEEPGRAM_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DISCORD_TOKEN',
  'WEB_API_TOKEN',
  'GATEWAY_API_TOKEN',
] as const;

export type RuntimeSecretKey = (typeof SECRET_KEYS)[number];
type RuntimeSecrets = Partial<Record<RuntimeSecretKey, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readRuntimeSecrets(homeDir: string = os.homedir()): RuntimeSecrets {
  const filePath = runtimeSecretsPath(homeDir);
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

export function runtimeSecretsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.hybridclaw', RUNTIME_SECRETS_FILE);
}

export function loadRuntimeSecrets(
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
): void {
  const secrets = readRuntimeSecrets(homeDir);
  const legacySecrets = readLegacyEnvSecrets(cwd);
  const migratedSecrets: RuntimeSecrets = {};

  for (const key of SECRET_KEYS) {
    if (secrets[key] || !legacySecrets[key]) continue;
    migratedSecrets[key] = legacySecrets[key];
  }

  if (Object.keys(migratedSecrets).length > 0) {
    const destination = runtimeSecretsPath(homeDir);
    console.info(`Migrating .env to ${destination}`);
    try {
      saveRuntimeSecrets(migratedSecrets, homeDir);
    } catch (err) {
      console.warn(
        `[runtime-secrets] failed to migrate legacy .env secrets to ${destination}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const key of SECRET_KEYS) {
    const value = secrets[key] || migratedSecrets[key];
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function saveRuntimeSecrets(
  updates: Partial<Record<RuntimeSecretKey, string | null>>,
  homeDir: string = os.homedir(),
): string {
  const filePath = runtimeSecretsPath(homeDir);
  const next = readRuntimeSecrets(homeDir);

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

  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return filePath;
}
