import fs from 'node:fs';
import os from 'node:os';

import {
  HYBRIDAI_API_KEY,
  MissingRequiredEnvVarError,
  refreshRuntimeSecretsFromEnv,
} from '../config/config.js';
import { runtimeSecretsPath } from '../security/runtime-secrets.js';

export interface HybridAIAuthStatus {
  authenticated: boolean;
  path: string;
  maskedApiKey: string | null;
  source: 'env' | 'runtime-secrets' | null;
}

function readCurrentApiKey(): string {
  refreshRuntimeSecretsFromEnv();
  return (process.env.HYBRIDAI_API_KEY || HYBRIDAI_API_KEY || '').trim();
}

function maskToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function getHybridAIApiKey(): string {
  const apiKey = readCurrentApiKey();
  if (!apiKey) throw new MissingRequiredEnvVarError('HYBRIDAI_API_KEY');
  return apiKey;
}

export function getHybridAIAuthStatus(
  homeDir: string = os.homedir(),
): HybridAIAuthStatus {
  const path = runtimeSecretsPath(homeDir);
  const apiKey = readCurrentApiKey();
  if (!apiKey) {
    return {
      authenticated: false,
      path,
      maskedApiKey: null,
      source: null,
    };
  }

  return {
    authenticated: true,
    path,
    maskedApiKey: maskToken(apiKey),
    source: fs.existsSync(path) ? 'runtime-secrets' : 'env',
  };
}
