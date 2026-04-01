export type ProviderKind =
  | 'hybridai'
  | 'openai-codex'
  | 'openrouter'
  | 'mistral'
  | 'huggingface'
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm';

export interface McpServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface TaskModelPolicy {
  provider?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
  model: string;
  chatbotId?: string;
  maxTokens?: number;
  error?: string;
}

export const TASK_MODEL_KEYS = [
  'vision',
  'compression',
  'web_extract',
  'session_search',
  'skills_hub',
  'mcp',
  'flush_memories',
] as const;

export type TaskModelKey = (typeof TASK_MODEL_KEYS)[number];

export type TaskModelPolicies = {
  [K in TaskModelKey]?: TaskModelPolicy;
};

export interface ContextGuardConfig {
  enabled: boolean;
  perResultShare: number;
  compactionRatio: number;
  overflowRatio: number;
  maxRetries: number;
}
