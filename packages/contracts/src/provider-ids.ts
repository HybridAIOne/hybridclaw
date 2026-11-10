/**
 * Provider ids — the one list of model providers, shared by the gateway, the
 * container, and the console. Every other provider list, union, prefix table,
 * or slash-command choice derives from these arrays.
 *
 * A model id names its provider with a `${id}/` prefix; a bare id is a HybridAI
 * passthrough. Guards and derived lists live in
 * `packages/shared/src/provider-ids.ts`; labels, secret keys, and default URLs
 * in `src/providers/provider-meta.ts`.
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
  'nebius',
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
