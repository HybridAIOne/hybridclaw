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
  // If the model carries a known non-hybridai provider prefix (e.g.
  // `kilo/...`, `mistral/...`, `gemini/...`), leave it untouched. Everything
  // else — including bare names and unknown-prefix ids — is treated as a
  // hybridai upstream model and gets the `hybridai/` display prefix prepended
  // so downstream UI rendering is consistent.
  if (hasKnownNonHybridProviderPrefix(normalized)) {
    return normalized;
  }
  return `${HYBRIDAI_MODEL_PREFIX}${normalized}`;
}

/**
 * Singular/plural count suffix shown at the end of `/model list` output
 * across every channel (TUI, Discord, Slack, web gateway, ...). Kept here so
 * every renderer formats the same way without re-implementing the rule.
 */
export function formatModelCountSuffix(count: number): string {
  const n = Math.max(0, Math.floor(count));
  return `${n} ${pluralize(n, 'model', 'models')}`;
}
