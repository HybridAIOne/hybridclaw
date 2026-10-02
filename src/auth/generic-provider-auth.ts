/**
 * Generic API-key providers — the OpenAI-compatible providers whose
 * `hybridclaw auth login|status|logout` flow is the same apart from these
 * fields: label, login defaults, secret key, and env var names.
 *
 * The CLI login/logout flows and the shared status lines (`auth-status.ts`)
 * read this table. NOT the provider runtime (`openai-compat-remote.ts`), and
 * NOT the target-name table (`auth-targets.ts`).
 */

export interface GenericProviderAuthDef {
  /** Provider ID used in CLI and config. */
  id:
    | 'openai'
    | 'gemini'
    | 'deepseek'
    | 'xai'
    | 'zai'
    | 'kimi'
    | 'minimax'
    | 'dashscope'
    | 'xiaomi'
    | 'kilo';
  /** Human-readable label shown in status/error output. */
  label: string;
  /** Default model used when none is specified. */
  defaultModel: string;
  /** Default base URL for the API. */
  defaultBaseUrl: string;
  /** Regex to detect the URL path suffix that should be present. */
  baseUrlSuffixPattern: RegExp;
  /** Suffix appended to the base URL if the pattern doesn't match. */
  baseUrlSuffix: string;
  /** Canonical secret key name used for encrypted storage. */
  secretKey: string;
  /** All env var names checked for this provider (order matters). */
  envVarNames: string[];
}

export const GENERIC_PROVIDER_AUTH_DEFS: readonly GenericProviderAuthDef[] = [
  {
    id: 'openai',
    label: 'OpenAI API',
    defaultModel: 'openai/gpt-5.6-sol',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'OPENAI_API_KEY',
    envVarNames: ['OPENAI_API_KEY'],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini/gemini-2.5-pro',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    baseUrlSuffixPattern: /\/openai$/i,
    baseUrlSuffix: '/openai',
    secretKey: 'GEMINI_API_KEY',
    envVarNames: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek/deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'DEEPSEEK_API_KEY',
    envVarNames: ['DEEPSEEK_API_KEY'],
  },
  {
    id: 'xai',
    label: 'xAI',
    defaultModel: 'xai/grok-3',
    defaultBaseUrl: 'https://api.x.ai/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'XAI_API_KEY',
    envVarNames: ['XAI_API_KEY'],
  },
  {
    id: 'zai',
    label: 'Z.AI / GLM',
    defaultModel: 'zai/glm-5.1',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    baseUrlSuffixPattern: /\/v4$/i,
    baseUrlSuffix: '/v4',
    secretKey: 'ZAI_API_KEY',
    envVarNames: ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
  },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot',
    defaultModel: 'kimi/kimi-k2.5',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'KIMI_API_KEY',
    envVarNames: ['KIMI_API_KEY'],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    defaultModel: 'minimax/MiniMax-M2',
    defaultBaseUrl: 'https://api.minimax.io/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'MINIMAX_API_KEY',
    envVarNames: ['MINIMAX_API_KEY'],
  },
  {
    id: 'dashscope',
    label: 'DashScope / Qwen',
    defaultModel: 'dashscope/qwen3-coder-plus',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'DASHSCOPE_API_KEY',
    envVarNames: ['DASHSCOPE_API_KEY'],
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi MiMo',
    defaultModel: 'xiaomi/MiMo-7B-RL',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    baseUrlSuffixPattern: /\/v1$/i,
    baseUrlSuffix: '/v1',
    secretKey: 'XIAOMI_API_KEY',
    envVarNames: ['XIAOMI_API_KEY'],
  },
  {
    id: 'kilo',
    label: 'Kilo Code',
    defaultModel: 'kilo/anthropic/claude-sonnet-4.6',
    defaultBaseUrl: 'https://api.kilo.ai/api/gateway',
    baseUrlSuffixPattern: /\/api\/gateway$/i,
    baseUrlSuffix: '/api/gateway',
    secretKey: 'KILO_API_KEY',
    envVarNames: ['KILOCODE_API_KEY', 'KILO_API_KEY'],
  },
] as const;

const GENERIC_PROVIDER_BY_ID = new Map(
  GENERIC_PROVIDER_AUTH_DEFS.map((def) => [def.id, def]),
);

export function findGenericProviderDef(
  id: string,
): GenericProviderAuthDef | undefined {
  return GENERIC_PROVIDER_BY_ID.get(id as GenericProviderAuthDef['id']);
}
