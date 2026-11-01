import { providerModelPrefix } from './provider-ids.js';

export const OPENROUTER_MODEL_PREFIX = providerModelPrefix('openrouter');
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
