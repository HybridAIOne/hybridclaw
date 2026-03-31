import fs from 'node:fs';
import {
  MissingRequiredEnvVarError,
  refreshRuntimeSecretsFromEnv,
} from '../config/config.js';
import { runtimeSecretsPath } from '../security/runtime-secrets.js';

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

export function readProviderApiKey(
  getEnvValues: () => Array<string | undefined>,
  missingEnvVar: string,
  opts?: { required?: boolean },
): string {
  refreshProviderSecretsIfNeeded();
  const apiKey =
    getEnvValues().find((value) => typeof value === 'string' && value) || '';
  const normalized = apiKey.trim();
  if (!normalized && opts?.required !== false) {
    throw new MissingRequiredEnvVarError(missingEnvVar);
  }
  return normalized;
}
