/**
 * Provider metadata — the one display label, secret-store key, and config
 * default per runtime provider. The TUI banner, auth status, provider
 * diagnostics, runtime-config defaults, and the console all read it, so a
 * provider is named and defaulted the same way on every surface.
 *
 * NOT the id list (`container/shared/src/provider-ids.ts`) and NOT the per-flow
 * auth details (`src/auth/generic-provider-auth.ts`). Imports only from
 * `container/shared` so the console can import it.
 */
import { ANTHROPIC_DEFAULT_BASE_URL } from '#shared/anthropic-utils.js';
import type { RuntimeProviderId } from './provider-ids.js';

export interface ProviderMeta {
  label: string;
  /** Canonical key of the provider's API key in the encrypted secret store. */
  secretKey?: string;
  /** Environment variables that also supply the API key, in lookup order. */
  envVars?: readonly string[];
  /** Default `baseUrl` of the provider's top-level config section. */
  defaultBaseUrl?: string;
  /** Default `models` of that section; the first is the login default. */
  defaultModels?: readonly string[];
}

export const PROVIDER_META = {
  hybridai: {
    label: 'HybridAI',
    secretKey: 'HYBRIDAI_API_KEY',
    envVars: ['HYBRIDAI_API_KEY'],
    defaultBaseUrl: 'https://hybridai.one',
  },
  openai: {
    label: 'OpenAI API',
    secretKey: 'OPENAI_API_KEY',
    envVars: ['OPENAI_API_KEY'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModels: [
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
    ],
  },
  'openai-codex': { label: 'Codex' },
  anthropic: {
    label: 'Anthropic',
    secretKey: 'ANTHROPIC_API_KEY',
    envVars: ['ANTHROPIC_API_KEY'],
    defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
    defaultModels: ['anthropic/claude-sonnet-4-6'],
  },
  openrouter: {
    label: 'OpenRouter',
    secretKey: 'OPENROUTER_API_KEY',
    envVars: ['OPENROUTER_API_KEY'],
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModels: ['openrouter/anthropic/claude-sonnet-4'],
  },
  mistral: {
    label: 'Mistral',
    secretKey: 'MISTRAL_API_KEY',
    envVars: ['MISTRAL_API_KEY'],
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultModels: ['mistral/mistral-large-latest'],
  },
  huggingface: {
    label: 'Hugging Face',
    secretKey: 'HF_TOKEN',
    envVars: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
    defaultBaseUrl: 'https://router.huggingface.co/v1',
    defaultModels: ['huggingface/meta-llama/Llama-3.1-8B-Instruct'],
  },
  gemini: {
    label: 'Google Gemini',
    secretKey: 'GEMINI_API_KEY',
    envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModels: ['gemini/gemini-2.5-pro', 'gemini/gemini-2.5-flash'],
  },
  deepseek: {
    label: 'DeepSeek',
    secretKey: 'DEEPSEEK_API_KEY',
    envVars: ['DEEPSEEK_API_KEY'],
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModels: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'],
  },
  xai: {
    label: 'xAI',
    secretKey: 'XAI_API_KEY',
    envVars: ['XAI_API_KEY'],
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModels: ['xai/grok-3'],
  },
  zai: {
    label: 'Z.AI / GLM',
    secretKey: 'ZAI_API_KEY',
    envVars: ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModels: ['zai/glm-5.1'],
  },
  kimi: {
    label: 'Kimi / Moonshot',
    secretKey: 'KIMI_API_KEY',
    envVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    defaultModels: ['kimi/kimi-k2.5'],
  },
  minimax: {
    label: 'MiniMax',
    secretKey: 'MINIMAX_API_KEY',
    envVars: ['MINIMAX_API_KEY'],
    defaultBaseUrl: 'https://api.minimax.io/v1',
    defaultModels: ['minimax/MiniMax-M2'],
  },
  dashscope: {
    label: 'DashScope / Qwen',
    secretKey: 'DASHSCOPE_API_KEY',
    envVars: ['DASHSCOPE_API_KEY'],
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModels: ['dashscope/qwen3-coder-plus'],
  },
  xiaomi: {
    label: 'Xiaomi MiMo',
    secretKey: 'XIAOMI_API_KEY',
    envVars: ['XIAOMI_API_KEY'],
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModels: ['xiaomi/MiMo-7B-RL'],
  },
  kilo: {
    label: 'Kilo Code',
    secretKey: 'KILO_API_KEY',
    envVars: ['KILOCODE_API_KEY', 'KILO_API_KEY'],
    defaultBaseUrl: 'https://api.kilo.ai/api/gateway',
    defaultModels: ['kilo/anthropic/claude-sonnet-4.6'],
  },
  ollama: { label: 'Ollama' },
  lmstudio: { label: 'LM Studio' },
  llamacpp: { label: 'llama.cpp' },
  vllm: { label: 'vLLM', secretKey: 'VLLM_API_KEY' },
  mlx: { label: 'MLX' },
} as const satisfies Record<RuntimeProviderId, ProviderMeta>;

/** Providers authenticated by an API key from the secret store or env. */
export type ApiKeyProviderId = {
  [Id in RuntimeProviderId]: (typeof PROVIDER_META)[Id] extends {
    envVars: readonly string[];
  }
    ? Id
    : never;
}[RuntimeProviderId];
