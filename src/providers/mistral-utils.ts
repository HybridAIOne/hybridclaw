import { MISTRAL_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const MISTRAL_MODEL_PREFIX = 'mistral/';

const DEPRECATED_MISTRAL_MODEL_IDS = [
  'magistral-medium-2507',
  'magistral-small-2507',
  'magistral-medium-2506',
  'magistral-small-2506',
  'devstral-small-2505',
  'mistral-small-2503',
  'mistral-ocr-2503',
  'mistral-saba-2502',
  'mistral-small-2501',
  'codestral-2501',
  'ministral-3b-2410',
  'ministral-8b-2410',
  'mistral-small-2409',
  'pixtral-12b-2409',
  'mistral-large-2407',
  'open-codestral-mamba',
  'mathstral-7b',
  'codestral-2405',
  'open-mistral-7b',
  'open-mixtral-8x22b',
  'mistral-small-2402',
  'mistral-large-2402',
  'mistral-next',
  'mistral-medium-2312',
  'open-mixtral-8x7b',
  'mistral-7b',
  'mixtral-8x22b',
  'mixtral-8x7b',
  'pixtral-12b',
  'mathstral',
  'ocr',
] as const;

const DEPRECATED_MISTRAL_MODEL_SET = new Set(
  DEPRECATED_MISTRAL_MODEL_IDS.map((modelId) => modelId.toLowerCase()),
);

export function normalizeMistralModelName(modelId: string): string {
  const normalized = String(modelId || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(MISTRAL_MODEL_PREFIX)) {
    return normalized;
  }
  return `${MISTRAL_MODEL_PREFIX}${normalized}`;
}

function normalizeMistralModelTail(model: string): string {
  const normalized = normalizeMistralModelName(model).toLowerCase();
  return normalized.startsWith(MISTRAL_MODEL_PREFIX)
    ? normalized.slice(MISTRAL_MODEL_PREFIX.length)
    : normalized;
}

export function isDeprecatedMistralModel(model: string): boolean {
  const tail = normalizeMistralModelTail(model);
  return DEPRECATED_MISTRAL_MODEL_SET.has(tail);
}

export function readMistralApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.MISTRAL_API_KEY, MISTRAL_API_KEY],
    'MISTRAL_API_KEY',
    opts,
  );
}
