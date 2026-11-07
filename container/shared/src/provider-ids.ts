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
] as const;

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
] as const;

export const RUNTIME_PROVIDER_IDS = [
  'hybridai',
  'openai',
  'openai-codex',
  'anthropic',
  ...OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
  ...LOCAL_BACKEND_IDS,
] as const;

export type LocalBackendType = (typeof LOCAL_BACKEND_IDS)[number];
export type OpenAICompatRemoteProviderId =
  (typeof OPENAI_COMPAT_REMOTE_PROVIDER_IDS)[number];
export type RuntimeProviderId = (typeof RUNTIME_PROVIDER_IDS)[number];
export type OpenAICompatProviderId =
  | OpenAICompatRemoteProviderId
  | Exclude<LocalBackendType, 'ollama'>;
export type NonHybridProviderId = Exclude<RuntimeProviderId, 'hybridai'>;

export const OPENAI_COMPAT_PROVIDER_IDS: readonly OpenAICompatProviderId[] = [
  ...OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
  ...LOCAL_BACKEND_IDS.filter(
    (id): id is Exclude<LocalBackendType, 'ollama'> => id !== 'ollama',
  ),
];

export const NON_HYBRID_PROVIDER_IDS: readonly NonHybridProviderId[] =
  RUNTIME_PROVIDER_IDS.filter(
    (id): id is NonHybridProviderId => id !== 'hybridai',
  );

const LOCAL_BACKEND_ID_SET = new Set<string>(LOCAL_BACKEND_IDS);
const RUNTIME_PROVIDER_ID_SET = new Set<string>(RUNTIME_PROVIDER_IDS);
const OPENAI_COMPAT_PROVIDER_ID_SET = new Set<string>(
  OPENAI_COMPAT_PROVIDER_IDS,
);
const OPENAI_COMPAT_REMOTE_PROVIDER_ID_SET = new Set<string>(
  OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
);

export function isLocalBackendType(value: string): value is LocalBackendType {
  return LOCAL_BACKEND_ID_SET.has(value);
}

export function isRuntimeProviderId(
  value: unknown,
): value is RuntimeProviderId {
  return typeof value === 'string' && RUNTIME_PROVIDER_ID_SET.has(value);
}

export function isOpenAICompatProviderId(
  value: unknown,
): value is OpenAICompatProviderId {
  return typeof value === 'string' && OPENAI_COMPAT_PROVIDER_ID_SET.has(value);
}

export function isOpenAICompatRemoteProviderId(
  value: unknown,
): value is OpenAICompatRemoteProviderId {
  return (
    typeof value === 'string' && OPENAI_COMPAT_REMOTE_PROVIDER_ID_SET.has(value)
  );
}

export function providerModelPrefix<Id extends string>(id: Id): `${Id}/` {
  return `${id}/`;
}

/** The non-HybridAI provider a model id's `${id}/` prefix names, if any. */
export function inferProviderFromModelPrefix(
  model: string,
): NonHybridProviderId | undefined {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  return NON_HYBRID_PROVIDER_IDS.find((id) =>
    normalized.startsWith(providerModelPrefix(id)),
  );
}
