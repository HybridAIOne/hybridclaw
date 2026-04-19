import fs from 'node:fs';
import {
  MissingRequiredEnvVarError,
  refreshRuntimeSecretsFromEnv,
} from '../config/config.js';
import {
  readStoredRuntimeSecrets,
  runtimeSecretsPath,
} from '../security/runtime-secrets.js';

const PROVIDER_API_KEY_REFRESH_DEBOUNCE_MS = 250;
let lastProviderApiKeyRefreshAt = 0;
let lastRuntimeSecretsSignature: string | null = null;

function readRuntimeSecretsSignature(): string {
  try {
    const stats = fs.statSync(runtimeSecretsPath(), { bigint: true });
    return `${stats.mtimeNs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

function refreshProviderSecretsIfNeeded(): void {
  const now = Date.now();
  const currentSignature = readRuntimeSecretsSignature();
  if (
    lastProviderApiKeyRefreshAt > 0 &&
    now - lastProviderApiKeyRefreshAt < PROVIDER_API_KEY_REFRESH_DEBOUNCE_MS &&
    currentSignature === lastRuntimeSecretsSignature
  ) {
    return;
  }
  refreshRuntimeSecretsFromEnv();
  lastProviderApiKeyRefreshAt = now;
  lastRuntimeSecretsSignature = readRuntimeSecretsSignature();
}

function parsePoolSecretList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getPoolListSecretNames(baseName: string): string[] {
  if (baseName.endsWith('_API_KEY')) {
    return [baseName.replace(/_API_KEY$/, '_API_KEYS'), `${baseName}_POOL`];
  }
  if (baseName.endsWith('_TOKEN')) {
    return [baseName.replace(/_TOKEN$/, '_TOKENS'), `${baseName}_POOL`];
  }
  return [`${baseName}_POOL`];
}

function readPooledProviderApiKey(missingEnvVar: string): string {
  const storedSecrets = readStoredRuntimeSecrets();
  const directCandidates = [
    process.env[missingEnvVar],
    storedSecrets[missingEnvVar],
  ];
  for (const candidate of directCandidates) {
    const normalized = String(candidate || '').trim();
    if (normalized) return normalized;
  }

  for (const listSecretName of getPoolListSecretNames(missingEnvVar)) {
    for (const source of [
      process.env[listSecretName],
      storedSecrets[listSecretName],
    ]) {
      const first = parsePoolSecretList(String(source || ''))[0];
      if (first) return first;
    }
  }

  const indexedSecretNames = new Set<string>();
  for (const source of [process.env, storedSecrets]) {
    for (const key of Object.keys(source)) {
      if (new RegExp(`^${missingEnvVar}_(\\d+)$`).test(key)) {
        indexedSecretNames.add(key);
      }
    }
  }

  for (const indexedSecretName of [...indexedSecretNames].sort(
    (left, right) => {
      const leftIndex = Number(left.slice(missingEnvVar.length + 1));
      const rightIndex = Number(right.slice(missingEnvVar.length + 1));
      return leftIndex - rightIndex;
    },
  )) {
    const normalized = String(
      process.env[indexedSecretName] || storedSecrets[indexedSecretName] || '',
    ).trim();
    if (normalized) return normalized;
  }

  return '';
}

export function readProviderApiKey(
  getEnvValues: () => Array<string | undefined>,
  missingEnvVar: string,
  opts?: { required?: boolean },
): string {
  refreshProviderSecretsIfNeeded();
  const apiKey =
    getEnvValues().find((value) => typeof value === 'string' && value) ||
    readPooledProviderApiKey(missingEnvVar);
  const normalized = apiKey.trim();
  if (!normalized && opts?.required !== false) {
    throw new MissingRequiredEnvVarError(missingEnvVar);
  }
  return normalized;
}
