import { inferProviderFromModelPrefix } from './provider-ids.js';

export const HYBRIDAI_MODEL_PREFIX = 'hybridai/';

export function hasKnownNonHybridProviderPrefix(model: string): boolean {
  return inferProviderFromModelPrefix(model) !== undefined;
}

export function hasDisplayOnlyHybridAIPrefix(model: string): boolean {
  const normalized = String(model || '').trim();
  if (!normalized.toLowerCase().startsWith(HYBRIDAI_MODEL_PREFIX)) {
    return false;
  }
  const upstreamModel = normalized.slice(HYBRIDAI_MODEL_PREFIX.length).trim();
  return (
    Boolean(upstreamModel) && !hasKnownNonHybridProviderPrefix(upstreamModel)
  );
}

export function stripProviderPrefix(model: string, prefix: string): string {
  const normalized = String(model || '').trim();
  const normalizedPrefix = `${String(prefix || '')
    .trim()
    .replace(/\/+$/g, '')}/`;
  if (!normalizedPrefix || normalizedPrefix === '/') {
    return normalized;
  }
  if (!normalized.toLowerCase().startsWith(normalizedPrefix.toLowerCase())) {
    return normalized;
  }
  const upstreamModel = normalized.slice(normalizedPrefix.length).trim();
  return upstreamModel || normalized;
}

export function stripHybridAIModelPrefix(model: string): string {
  return stripProviderPrefix(model, HYBRIDAI_MODEL_PREFIX);
}

export function formatHybridAIModelForCatalog(model: string): string {
  const normalized = stripHybridAIModelPrefix(model);
  if (normalized.toLowerCase() === HYBRIDAI_MODEL_PREFIX) return '';
  if (!normalized) return '';
  return `${HYBRIDAI_MODEL_PREFIX}${normalized}`;
}

export function normalizeHybridAIModelForRuntime(model: string): string {
  const normalized = String(model || '').trim();
  if (!hasDisplayOnlyHybridAIPrefix(normalized)) {
    return normalized;
  }
  return normalized.slice(HYBRIDAI_MODEL_PREFIX.length).trim();
}
