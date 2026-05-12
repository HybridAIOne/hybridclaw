import type { RuntimeProviderId } from '../providers/provider-ids.js';

export type ProviderKind = RuntimeProviderId;

export type AnthropicMethod = 'api-key' | 'claude-cli';

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
  provider?: ProviderKind | undefined;
  providerMethod?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  requestHeaders?: Record<string, string> | undefined;
  isLocal?: boolean | undefined;
  contextWindow?: number | undefined;
  thinkingFormat?: 'qwen' | undefined;
  model: string;
  chatbotId?: string | undefined;
  maxTokens?: number | undefined;
  error?: string | undefined;
}

export const TASK_MODEL_KEYS = [
  'vision',
  'compression',
  'web_extract',
  'session_search',
  'skills_hub',
  'eval_judge',
  'mcp',
  'flush_memories',
  'session_title',
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
