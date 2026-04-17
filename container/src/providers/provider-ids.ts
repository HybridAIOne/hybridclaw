export const RUNTIME_PROVIDER_IDS = [
  'hybridai',
  'openai-codex',
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
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
] as const;

export const OPENAI_COMPAT_RUNTIME_PROVIDER_IDS = [
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
  'lmstudio',
  'llamacpp',
  'vllm',
] as const;

export type RuntimeProvider = (typeof RUNTIME_PROVIDER_IDS)[number];
export type OpenAICompatRuntimeProvider =
  (typeof OPENAI_COMPAT_RUNTIME_PROVIDER_IDS)[number];

const RUNTIME_PROVIDER_ID_SET = new Set<string>(RUNTIME_PROVIDER_IDS);
const OPENAI_COMPAT_RUNTIME_PROVIDER_ID_SET = new Set<string>(
  OPENAI_COMPAT_RUNTIME_PROVIDER_IDS,
);

export function isRuntimeProvider(value: unknown): value is RuntimeProvider {
  return typeof value === 'string' && RUNTIME_PROVIDER_ID_SET.has(value);
}

export function isOpenAICompatRuntimeProvider(
  value: unknown,
): value is OpenAICompatRuntimeProvider {
  return (
    typeof value === 'string' &&
    OPENAI_COMPAT_RUNTIME_PROVIDER_ID_SET.has(value)
  );
}
