import { ANTHROPIC_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';
import { normalizeBaseUrl } from './utils.js';

export const ANTHROPIC_MODEL_PREFIX = 'anthropic/';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_TOOL_STREAMING_BETA =
  'fine-grained-tool-streaming-2025-05-14';
export const ANTHROPIC_CLAUDE_CODE_BETAS = `claude-code-20250219,oauth-2025-04-20,${ANTHROPIC_TOOL_STREAMING_BETA}`;
export const ANTHROPIC_CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.75';

export function isAnthropicModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(ANTHROPIC_MODEL_PREFIX);
}

export function normalizeAnthropicModelName(modelId: string): string {
  const normalized = String(modelId || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(ANTHROPIC_MODEL_PREFIX)) {
    return normalized;
  }
  return `${ANTHROPIC_MODEL_PREFIX}${normalized}`;
}

export function stripAnthropicModelPrefix(modelId: string): string {
  const normalized = String(modelId || '').trim();
  if (!normalized.toLowerCase().startsWith(ANTHROPIC_MODEL_PREFIX)) {
    return normalized;
  }
  return normalized.slice(ANTHROPIC_MODEL_PREFIX.length) || normalized;
}

export function normalizeAnthropicBaseUrl(rawBaseUrl: string): string {
  const normalized = normalizeBaseUrl(rawBaseUrl);
  if (!normalized) return ANTHROPIC_DEFAULT_BASE_URL;
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

export function isAnthropicOAuthToken(value: string): boolean {
  return String(value || '').includes('sk-ant-oat');
}

export function buildAnthropicRequestHeaders(params: {
  apiKey: string;
}): Record<string, string> {
  return isAnthropicOAuthToken(params.apiKey)
    ? {
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_CLAUDE_CODE_BETAS,
        'user-agent': ANTHROPIC_CLAUDE_CODE_USER_AGENT,
        'x-app': 'cli',
      }
    : {
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_TOOL_STREAMING_BETA,
      };
}

export function readAnthropicApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.ANTHROPIC_API_KEY, ANTHROPIC_API_KEY],
    'ANTHROPIC_API_KEY',
    opts,
  );
}
