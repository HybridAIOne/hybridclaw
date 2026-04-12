export const LOCAL_BACKEND_IDS = [
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
] as const;

export const RUNTIME_PROVIDER_IDS = [
  'hybridai',
  'openai-codex',
  'openrouter',
  'mistral',
  'huggingface',
  ...LOCAL_BACKEND_IDS,
] as const;

export const AI_PROVIDER_IDS = [...RUNTIME_PROVIDER_IDS, 'anthropic'] as const;

export const OPENAI_COMPAT_PROVIDER_IDS = [
  'openrouter',
  'mistral',
  'huggingface',
  'lmstudio',
  'llamacpp',
  'vllm',
] as const;

export type LocalBackendType = (typeof LOCAL_BACKEND_IDS)[number];
export type RuntimeProviderId = (typeof RUNTIME_PROVIDER_IDS)[number];
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];
export type OpenAICompatProviderId =
  (typeof OPENAI_COMPAT_PROVIDER_IDS)[number];

const LOCAL_BACKEND_ID_SET = new Set<string>(LOCAL_BACKEND_IDS);
const RUNTIME_PROVIDER_ID_SET = new Set<string>(RUNTIME_PROVIDER_IDS);
const AI_PROVIDER_ID_SET = new Set<string>(AI_PROVIDER_IDS);
const OPENAI_COMPAT_PROVIDER_ID_SET = new Set<string>(
  OPENAI_COMPAT_PROVIDER_IDS,
);

export function isLocalBackendType(value: string): value is LocalBackendType {
  return LOCAL_BACKEND_ID_SET.has(value);
}

export function isRuntimeProviderId(
  value: unknown,
): value is RuntimeProviderId {
  return typeof value === 'string' && RUNTIME_PROVIDER_ID_SET.has(value);
}

export function isAIProviderId(value: unknown): value is AIProviderId {
  return typeof value === 'string' && AI_PROVIDER_ID_SET.has(value);
}

export function isOpenAICompatProviderId(
  value: unknown,
): value is OpenAICompatProviderId {
  return typeof value === 'string' && OPENAI_COMPAT_PROVIDER_ID_SET.has(value);
}
