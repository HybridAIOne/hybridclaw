import {
  formatHybridAIModelForCatalog,
  HYBRIDAI_MODEL_PREFIX,
  normalizeHybridAIModelForRuntime,
  stripHybridAIModelPrefix,
  stripProviderPrefix,
} from '../../container/shared/model-names.js';

export {
  formatHybridAIModelForCatalog,
  HYBRIDAI_MODEL_PREFIX,
  normalizeHybridAIModelForRuntime,
  stripHybridAIModelPrefix,
  stripProviderPrefix,
};

export function formatModelForDisplay(model: string): string {
  const normalized = String(model || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(HYBRIDAI_MODEL_PREFIX)) {
    return normalized;
  }
  // Any model that already carries a provider prefix (e.g. `kilo/...`,
  // `mistral/...`, `openrouter/...`) is non-hybridai by construction — don't
  // prepend `hybridai/`. Only bare names (no slash) are hybridai upstream
  // models that need the display prefix prepended.
  if (normalized.includes('/')) {
    return normalized;
  }
  return `${HYBRIDAI_MODEL_PREFIX}${normalized}`;
}
