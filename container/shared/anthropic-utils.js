export const ANTHROPIC_MODEL_PREFIX = 'anthropic/';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

export function normalizeAnthropicModelName(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(ANTHROPIC_MODEL_PREFIX)) {
    return normalized;
  }
  return `${ANTHROPIC_MODEL_PREFIX}${normalized}`;
}

export function stripAnthropicModelPrefix(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized.toLowerCase().startsWith(ANTHROPIC_MODEL_PREFIX)) {
    return normalized;
  }
  return normalized.slice(ANTHROPIC_MODEL_PREFIX.length) || normalized;
}

export function normalizeAnthropicBaseUrl(rawBaseUrl) {
  const normalized = String(rawBaseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
  if (!normalized) return ANTHROPIC_DEFAULT_BASE_URL;
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

export function isAnthropicOAuthToken(value) {
  return String(value || '').includes('sk-ant-oat');
}
