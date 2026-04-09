import {
  formatHybridAIModelForCatalog,
  HYBRIDAI_MODEL_PREFIX,
  hasKnownNonHybridProviderPrefix,
  normalizeHybridAIModelForRuntime,
  stripHybridAIModelPrefix,
} from '../../container/shared/model-names.js';

export {
  formatHybridAIModelForCatalog,
  HYBRIDAI_MODEL_PREFIX,
  normalizeHybridAIModelForRuntime,
  stripHybridAIModelPrefix,
};

export function formatModelForDisplay(model: string): string {
  const normalized = String(model || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(HYBRIDAI_MODEL_PREFIX)) {
    return normalized;
  }
  if (hasKnownNonHybridProviderPrefix(normalized)) {
    return normalized;
  }
  return `${HYBRIDAI_MODEL_PREFIX}${normalized}`;
}
