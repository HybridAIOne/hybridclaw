import { MISTRAL_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const MISTRAL_MODEL_PREFIX = 'mistral/';

export function normalizeMistralModelName(modelId: string): string {
  const normalized = String(modelId || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(MISTRAL_MODEL_PREFIX)) {
    return normalized;
  }
  return `${MISTRAL_MODEL_PREFIX}${normalized}`;
}

export function readMistralApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.MISTRAL_API_KEY, MISTRAL_API_KEY],
    'MISTRAL_API_KEY',
    opts,
  );
}
