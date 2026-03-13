import {
  MissingRequiredEnvVarError,
  OPENROUTER_API_KEY,
  refreshRuntimeSecretsFromEnv,
} from '../config/config.js';

export const OPENROUTER_MODEL_PREFIX = 'openrouter/';
export const OPENROUTER_REFERER = 'https://github.com/hybridaione/hybridclaw';
export const OPENROUTER_TITLE = 'HybridClaw';

export function readOpenRouterApiKey(opts?: { required?: boolean }): string {
  refreshRuntimeSecretsFromEnv();
  const apiKey = process.env.OPENROUTER_API_KEY || OPENROUTER_API_KEY || '';
  const normalized = apiKey.trim();
  if (!normalized && opts?.required !== false) {
    throw new MissingRequiredEnvVarError('OPENROUTER_API_KEY');
  }
  return normalized;
}
