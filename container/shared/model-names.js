export const HYBRIDAI_MODEL_PREFIX = 'hybridai/';

export const NON_HYBRID_PROVIDER_PREFIXES = [
  'openai-codex/',
  'openrouter/',
  'mistral/',
  'huggingface/',
  'anthropic/',
  'ollama/',
  'lmstudio/',
  'llamacpp/',
  'vllm/',
];

export function hasKnownNonHybridProviderPrefix(model) {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  return NON_HYBRID_PROVIDER_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export function hasDisplayOnlyHybridAIPrefix(model) {
  const normalized = String(model || '').trim();
  if (!normalized.toLowerCase().startsWith(HYBRIDAI_MODEL_PREFIX)) {
    return false;
  }
  const upstreamModel = normalized.slice(HYBRIDAI_MODEL_PREFIX.length).trim();
  return (
    Boolean(upstreamModel) && !hasKnownNonHybridProviderPrefix(upstreamModel)
  );
}

export function stripProviderPrefix(model, prefix) {
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

export function stripHybridAIModelPrefix(model) {
  return stripProviderPrefix(model, HYBRIDAI_MODEL_PREFIX);
}

export function formatHybridAIModelForCatalog(model) {
  const normalized = stripHybridAIModelPrefix(model);
  if (normalized.toLowerCase() === HYBRIDAI_MODEL_PREFIX) return '';
  if (!normalized) return '';
  return `${HYBRIDAI_MODEL_PREFIX}${normalized}`;
}

export function normalizeHybridAIModelForRuntime(model) {
  const normalized = String(model || '').trim();
  if (!hasDisplayOnlyHybridAIPrefix(normalized)) {
    return normalized;
  }
  return normalized.slice(HYBRIDAI_MODEL_PREFIX.length).trim();
}
