import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_RUNTIME_HOME_DIR } from './runtime-paths.js';

const RUNTIME_ENV_FILE = 'env.json';
const RUNTIME_ENV_VERSION = 1;
const RUNTIME_HOME_MODE = 0o700;
const RUNTIME_ENV_MODE = 0o600;
const RUNTIME_ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_LIKE_NAME_RE =
  /(^|_)(API_)?(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|AUTH)(_|$)/u;

const RESERVED_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'PWD',
  'OLDPWD',
  'SHELL',
  'USER',
  'LOGNAME',
  'NODE_OPTIONS',
  'NPM_CONFIG_PREFIX',
  'NPM_TOKEN',
]);

interface RuntimeEnvStore {
  version: typeof RUNTIME_ENV_VERSION;
  values: Record<string, string>;
}

export function runtimeEnvPath(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, RUNTIME_ENV_FILE);
}

export function isRuntimeEnvName(value: string): boolean {
  return RUNTIME_ENV_NAME_RE.test(String(value || '').trim());
}

export function isReservedRuntimeEnvName(value: string): boolean {
  const normalized = String(value || '').trim();
  return (
    RESERVED_ENV_NAMES.has(normalized) ||
    normalized.startsWith('HYBRIDCLAW_') ||
    normalized.startsWith('npm_') ||
    normalized.startsWith('NPM_')
  );
}

export function isSecretLikeRuntimeEnvName(value: string): boolean {
  return SECRET_LIKE_NAME_RE.test(String(value || '').trim());
}

export function validateRuntimeEnvName(name: string): string {
  const normalized = String(name || '').trim();
  if (!isRuntimeEnvName(normalized)) {
    throw new Error(
      'Env names must use uppercase letters, digits, and underscores only.',
    );
  }
  if (isReservedRuntimeEnvName(normalized)) {
    throw new Error(
      `\`${normalized}\` is reserved and cannot be stored as a runtime env value.`,
    );
  }
  if (isSecretLikeRuntimeEnvName(normalized)) {
    throw new Error(
      `\`${normalized}\` looks sensitive. Store credentials with \`hybridclaw secret set ${normalized} <value>\`.`,
    );
  }
  return normalized;
}

function ensureRuntimeHomeDir(): void {
  fs.mkdirSync(DEFAULT_RUNTIME_HOME_DIR, {
    recursive: true,
    mode: RUNTIME_HOME_MODE,
  });
  try {
    fs.chmodSync(DEFAULT_RUNTIME_HOME_DIR, RUNTIME_HOME_MODE);
  } catch {
    // Best effort only; runtime-secrets reports the same condition separately.
  }
}

function sanitizeRuntimeEnvValues(
  record: Record<string, unknown>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isRuntimeEnvName(key)) continue;
    if (isReservedRuntimeEnvName(key) || isSecretLikeRuntimeEnvName(key)) {
      continue;
    }
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) values[key] = normalized;
  }
  return values;
}

function readRuntimeEnvStore(): RuntimeEnvStore {
  const filePath = runtimeEnvPath();
  if (!fs.existsSync(filePath)) {
    return { version: RUNTIME_ENV_VERSION, values: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: RUNTIME_ENV_VERSION, values: {} };
    }
    const values = (parsed as { values?: unknown }).values;
    return {
      version: RUNTIME_ENV_VERSION,
      values:
        values && typeof values === 'object' && !Array.isArray(values)
          ? sanitizeRuntimeEnvValues(values as Record<string, unknown>)
          : {},
    };
  } catch {
    return { version: RUNTIME_ENV_VERSION, values: {} };
  }
}

function writeRuntimeEnvStore(store: RuntimeEnvStore): void {
  ensureRuntimeHomeDir();
  const filePath = runtimeEnvPath();
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: RUNTIME_ENV_MODE,
    });
    fs.chmodSync(tempPath, RUNTIME_ENV_MODE);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function readStoredRuntimeEnv(): Record<string, string> {
  return { ...readRuntimeEnvStore().values };
}

export function listStoredRuntimeEnvNames(): string[] {
  return Object.keys(readStoredRuntimeEnv()).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function readStoredRuntimeEnvValue(name: string): string | null {
  const normalized = validateRuntimeEnvName(name);
  return readStoredRuntimeEnv()[normalized] || null;
}

export function saveNamedRuntimeEnv(
  updates: Record<string, string | null>,
): void {
  const current = readStoredRuntimeEnv();
  for (const [rawName, value] of Object.entries(updates)) {
    const name = validateRuntimeEnvName(rawName);
    if (value === null) {
      delete current[name];
      continue;
    }
    const normalized = String(value || '').trim();
    if (!normalized) {
      delete current[name];
      continue;
    }
    current[name] = normalized;
  }
  writeRuntimeEnvStore({
    version: RUNTIME_ENV_VERSION,
    values: Object.fromEntries(
      Object.entries(current).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
}
