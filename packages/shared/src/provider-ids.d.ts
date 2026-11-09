export declare const LOCAL_BACKEND_IDS: readonly [
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
  'mlx',
];

export declare const OPENAI_COMPAT_REMOTE_PROVIDER_IDS: readonly [
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

export declare const RUNTIME_PROVIDER_IDS: readonly [
  'hybridai',
  'openai',
  'openai-codex',
  'anthropic',
  ...typeof OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
  ...typeof LOCAL_BACKEND_IDS,
];

export type LocalBackendType = (typeof LOCAL_BACKEND_IDS)[number];
export type OpenAICompatRemoteProviderId =
  (typeof OPENAI_COMPAT_REMOTE_PROVIDER_IDS)[number];
export type RuntimeProviderId = (typeof RUNTIME_PROVIDER_IDS)[number];
export type OpenAICompatProviderId =
  | OpenAICompatRemoteProviderId
  | Exclude<LocalBackendType, 'ollama'>;
export type NonHybridProviderId = Exclude<RuntimeProviderId, 'hybridai'>;

export declare const OPENAI_COMPAT_PROVIDER_IDS: readonly OpenAICompatProviderId[];
export declare const NON_HYBRID_PROVIDER_IDS: readonly NonHybridProviderId[];

export declare function isLocalBackendType(
  value: string,
): value is LocalBackendType;

export declare function isRuntimeProviderId(
  value: unknown,
): value is RuntimeProviderId;

export declare function isOpenAICompatProviderId(
  value: unknown,
): value is OpenAICompatProviderId;

export declare function isOpenAICompatRemoteProviderId(
  value: unknown,
): value is OpenAICompatRemoteProviderId;

export declare function providerModelPrefix<Id extends string>(
  id: Id,
): `${Id}/`;

/** The non-HybridAI provider a model id's `${id}/` prefix names, if any. */
export declare function inferProviderFromModelPrefix(
  model: string,
): NonHybridProviderId | undefined;
