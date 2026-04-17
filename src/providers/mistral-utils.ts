export const MISTRAL_MODEL_PREFIX = 'mistral/';

export function normalizeMistralModelName(modelId: string): string {
  const normalized = String(modelId || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(MISTRAL_MODEL_PREFIX)) {
    return normalized;
  }
  return `${MISTRAL_MODEL_PREFIX}${normalized}`;
}
