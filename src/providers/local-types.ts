import type {
  ModelBehavior,
  ModelThinkingFormat,
} from '../types/model-behavior.js';
import type { LocalBackendType } from './provider-ids.js';

export type { LocalBackendType } from './provider-ids.js';
export type LocalThinkingFormat = ModelThinkingFormat;
export type LocalModelBehavior = ModelBehavior;

export interface LocalModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  isReasoning: boolean;
  backend: LocalBackendType;
  endpointName?: string;
  thinkingFormat?: LocalThinkingFormat;
  modelBehavior?: LocalModelBehavior;
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
  modelBehavior?: LocalModelBehavior;
}

export interface LocalEndpointConfig extends LocalBackendConfig {
  name: string;
  type: LocalBackendType;
}

export interface LocalProviderConfig {
  backends: {
    ollama: LocalBackendConfig;
    lmstudio: LocalBackendConfig;
    llamacpp: LocalBackendConfig;
    vllm: LocalBackendConfig;
    browser: LocalBackendConfig;
  };
  endpoints: LocalEndpointConfig[];
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
