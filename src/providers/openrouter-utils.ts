import { OPENROUTER_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const OPENROUTER_MODEL_PREFIX = 'openrouter/';
export const OPENROUTER_REFERER = 'https://github.com/hybridaione/hybridclaw';
export const OPENROUTER_TITLE = 'HybridClaw';
export const OPENROUTER_CATEGORIES = ['cli-agent', 'general-chat'] as const;

export function buildOpenRouterAttributionHeaders(): Record<string, string> {
  return {
    'HTTP-Referer': OPENROUTER_REFERER,
    'X-OpenRouter-Title': OPENROUTER_TITLE,
    'X-OpenRouter-Categories': OPENROUTER_CATEGORIES.join(','),
    'X-Title': OPENROUTER_TITLE,
  };
}

export function readOpenRouterApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.OPENROUTER_API_KEY, OPENROUTER_API_KEY],
    'OPENROUTER_API_KEY',
    opts,
  );
}
