import type { LocalThinkingFormat } from './local-types.js';

export type AIProviderId =
  | 'hybridai'
  | 'openai-codex'
  | 'anthropic'
  | 'ollama'
  | 'lmstudio'
  | 'vllm';
export type RuntimeProviderId =
  | 'hybridai'
  | 'openai-codex'
  | 'ollama'
  | 'lmstudio'
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
}

export interface AIProvider {
  readonly id: AIProviderId;
  matchesModel(model: string): boolean;
  requiresChatbotId(model: string): boolean;
  resolveAgentId(model: string, chatbotId: string): string;
  resolveRuntimeCredentials(
    params: ResolveProviderRuntimeParams,
  ): Promise<ResolvedModelRuntimeCredentials>;
}
