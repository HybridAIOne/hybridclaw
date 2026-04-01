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

export function normalizeHybridAIModelForRuntime(model) {
  const normalized = String(model || '').trim();
  if (!hasDisplayOnlyHybridAIPrefix(normalized)) {
    return normalized;
  }
  return normalized.slice(HYBRIDAI_MODEL_PREFIX.length).trim();
}
