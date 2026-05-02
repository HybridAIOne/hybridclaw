import type { LocalThinkingFormat } from './local-types.js';
import type { AIProviderId, RuntimeProviderId } from './provider-ids.js';

export type { AIProviderId, RuntimeProviderId } from './provider-ids.js';

export interface ResolvedModelRuntimeCredentials {
  provider: RuntimeProviderId;
  providerMethod?: string;
  apiKey: string;
  baseUrl: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders: Record<string, string>;
  agentId: string;
  accountId?: string;
  isLocal?: boolean;
  contextWindow?: number;
  maxTokens?: number;
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
