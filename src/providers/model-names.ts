import {
  formatHybridAIModelForCatalog,
  HYBRIDAI_MODEL_PREFIX,
  hasKnownNonHybridProviderPrefix,
  normalizeHybridAIModelForRuntime,
  stripHybridAIModelPrefix,
  stripProviderPrefix,
} from '../../container/shared/model-names.js';
import { pluralize } from '../utils/text-format.js';

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
  if (hasKnownNonHybridProviderPrefix(normalized)) {
    return normalized;
  }
  return `${HYBRIDAI_MODEL_PREFIX}${normalized}`;
}

export function formatModelCountSuffix(count: number): string {
  const n = Math.max(0, Math.floor(count));
  return `${n} ${pluralize(n, 'model', 'models')}`;
}
