/**
 * Provider ids — the one list of model providers, shared by the gateway, the
 * container, and the console. Every other provider list, union, prefix table,
 * or slash-command choice derives from these arrays.
 *
 * A model id names its provider with a `${id}/` prefix; a bare id is a HybridAI
 * passthrough. Labels, secret keys, and default URLs live in
 * `src/providers/provider-meta.ts`, not here.
 */

export const LOCAL_BACKEND_IDS = [
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
  'mlx',
];

export const OPENAI_COMPAT_REMOTE_PROVIDER_IDS = [
  'openrouter',
  'mistral',
  'huggingface',
  'gemini',
  'deepseek',
  'xai',
  'zai',
  'kimi',
  'minimax',
  'dashscope',
  'xiaomi',
  'kilo',
];

export const RUNTIME_PROVIDER_IDS = [
  'hybridai',
  'openai',
  'openai-codex',
  'anthropic',
  ...OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
  ...LOCAL_BACKEND_IDS,
];

export const OPENAI_COMPAT_PROVIDER_IDS = [
  ...OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
  ...LOCAL_BACKEND_IDS.filter((id) => id !== 'ollama'),
];

export const NON_HYBRID_PROVIDER_IDS = RUNTIME_PROVIDER_IDS.filter(
  (id) => id !== 'hybridai',
);

const LOCAL_BACKEND_ID_SET = new Set(LOCAL_BACKEND_IDS);
const RUNTIME_PROVIDER_ID_SET = new Set(RUNTIME_PROVIDER_IDS);
const OPENAI_COMPAT_PROVIDER_ID_SET = new Set(OPENAI_COMPAT_PROVIDER_IDS);
const OPENAI_COMPAT_REMOTE_PROVIDER_ID_SET = new Set(
  OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
);

export function isLocalBackendType(value) {
  return LOCAL_BACKEND_ID_SET.has(value);
}

export function isRuntimeProviderId(value) {
  return typeof value === 'string' && RUNTIME_PROVIDER_ID_SET.has(value);
}

export function isOpenAICompatProviderId(value) {
  return typeof value === 'string' && OPENAI_COMPAT_PROVIDER_ID_SET.has(value);
}

export function isOpenAICompatRemoteProviderId(value) {
  return (
    typeof value === 'string' && OPENAI_COMPAT_REMOTE_PROVIDER_ID_SET.has(value)
  );
}

export function providerModelPrefix(id) {
  return `${id}/`;
}

export function inferProviderFromModelPrefix(model) {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  return NON_HYBRID_PROVIDER_IDS.find((id) =>
    normalized.startsWith(providerModelPrefix(id)),
  );
}
