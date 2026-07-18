import type {
  ModelBehavior,
  ModelThinkingFormat,
} from '../types/model-behavior.js';
import type { ModelRoutingZone } from './model-routing.js';
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
  zone: ModelRoutingZone;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  cost: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
}

export interface LocalEndpointPricingConfig {
  inputEurPerMillion: number | null;
  outputEurPerMillion: number | null;
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
  zone?: ModelRoutingZone;
  pricing?: LocalEndpointPricingConfig;
}

export interface LocalProviderConfig {
  backends: {
    ollama: LocalBackendConfig;
    lmstudio: LocalBackendConfig;
    llamacpp: LocalBackendConfig;
    vllm: LocalBackendConfig;
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
