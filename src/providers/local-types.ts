import type { LocalBackendType } from './provider-ids.js';

export type { LocalBackendType } from './provider-ids.js';
export type LocalThinkingFormat = 'qwen';

export interface LocalModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  isReasoning: boolean;
  backend: LocalBackendType;
  thinkingFormat?: LocalThinkingFormat;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  cost: {
    input: 0;
    output: 0;
    cacheRead: 0;
    cacheWrite: 0;
  };
}

export interface LocalBackendConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
}

export interface LocalProviderConfig {
  backends: {
    ollama: LocalBackendConfig;
    lmstudio: LocalBackendConfig;
    llamacpp: LocalBackendConfig;
    vllm: LocalBackendConfig;
  };
  discovery: {
    enabled: boolean;
    intervalMs: number;
    maxModels: number;
    concurrency: number;
  };
  healthCheck: {
    enabled: boolean;
    intervalMs: number;
    timeoutMs: number;
  };
  defaultContextWindow: number;
  defaultMaxTokens: number;
}

export interface HealthCheckResult {
  backend: LocalBackendType;
  reachable: boolean;
  latencyMs: number;
  error?: string;
  modelCount?: number;
}

export interface ModelHealthCheckResult {
  modelId: string;
  backend: LocalBackendType;
  usable: boolean;
  latencyMs: number;
  error?: string;
}
