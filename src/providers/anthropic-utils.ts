import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_MODEL_PREFIX,
  isAnthropicOAuthToken,
  normalizeAnthropicBaseUrl,
  normalizeAnthropicModelName,
  stripAnthropicModelPrefix,
} from '../../container/shared/anthropic-utils.js';

export const ANTHROPIC_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_TOOL_STREAMING_BETA =
  'fine-grained-tool-streaming-2025-05-14';
export const ANTHROPIC_CLAUDE_CODE_BETAS = `claude-code-20250219,oauth-2025-04-20,${ANTHROPIC_TOOL_STREAMING_BETA}`;
export const ANTHROPIC_CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.75';

export {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_MODEL_PREFIX,
  isAnthropicOAuthToken,
  normalizeAnthropicBaseUrl,
  normalizeAnthropicModelName,
  stripAnthropicModelPrefix,
};

export function isAnthropicModel(model: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(ANTHROPIC_MODEL_PREFIX);
}

export function buildAnthropicSupportingHeaders(params: {
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
