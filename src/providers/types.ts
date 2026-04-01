import type { LocalThinkingFormat } from './local-types.js';

export type AIProviderId =
  | 'hybridai'
  | 'openai-codex'
  | 'openrouter'
  | 'mistral'
  | 'huggingface'
  | 'anthropic'
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm';
export type RuntimeProviderId =
  | 'hybridai'
  | 'openai-codex'
  | 'openrouter'
  | 'mistral'
  | 'huggingface'
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm';

export interface ResolvedModelRuntimeCredentials {
  provider: RuntimeProviderId;
  apiKey: string;
  baseUrl: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders: Record<string, string>;
  agentId: string;
  accountId?: string;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: LocalThinkingFormat;
}

export interface ResolveProviderRuntimeParams {
  model: string;
  chatbotId?: string;
  enableRag?: boolean;
  agentId?: string;
}

export interface AIProvider {
  readonly id: AIProviderId;
  matchesModel(model: string): boolean;
  requiresChatbotId(model: string): boolean;
  resolveRuntimeCredentials(
    params: ResolveProviderRuntimeParams,
  ): Promise<ResolvedModelRuntimeCredentials>;
}
