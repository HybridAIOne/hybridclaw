export const RUNTIME_PROVIDER_IDS = [
  'hybridai',
  'openai-codex',
  'anthropic',
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
  'browser',
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
  'browser',
] as const;

export type RuntimeProvider = (typeof RUNTIME_PROVIDER_IDS)[number];
export type OpenAICompatRuntimeProvider =
  (typeof OPENAI_COMPAT_RUNTIME_PROVIDER_IDS)[number];

const RUNTIME_PROVIDER_MODEL_PREFIXES: Array<[RuntimeProvider, string]> = [
  ['openai-codex', 'openai-codex/'],
  ['anthropic', 'anthropic/'],
  ['openrouter', 'openrouter/'],
  ['mistral', 'mistral/'],
  ['huggingface', 'huggingface/'],
  ['gemini', 'gemini/'],
  ['deepseek', 'deepseek/'],
  ['xai', 'xai/'],
  ['zai', 'zai/'],
  ['kimi', 'kimi/'],
  ['minimax', 'minimax/'],
  ['dashscope', 'dashscope/'],
  ['xiaomi', 'xiaomi/'],
  ['kilo', 'kilo/'],
  ['ollama', 'ollama/'],
  ['lmstudio', 'lmstudio/'],
  ['llamacpp', 'llamacpp/'],
  ['vllm', 'vllm/'],
  ['browser', 'browser/'],
];

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

export function inferRuntimeProviderFromModel(
  model: string,
): RuntimeProvider | undefined {
  const normalized = String(model || '').trim();
  return RUNTIME_PROVIDER_MODEL_PREFIXES.find(([, prefix]) =>
    normalized.startsWith(prefix),
  )?.[0];
}

export function resolveRuntimeProviderContext(
  provider: RuntimeProvider | undefined,
  model: string,
): RuntimeProvider {
  return provider || inferRuntimeProviderFromModel(model) || 'hybridai';
}
