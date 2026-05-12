import type { LocalThinkingFormat } from './local-types.js';
import type { AIProviderId, RuntimeProviderId } from './provider-ids.js';

export type { AIProviderId, RuntimeProviderId } from './provider-ids.js';

export interface ResolvedModelRuntimeCredentials {
  provider: RuntimeProviderId;
  providerMethod?: string | undefined;
  model?: string | undefined;
  apiKey: string;
  baseUrl: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders: Record<string, string>;
  agentId: string;
  accountId?: string | undefined;
  isLocal?: boolean | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  thinkingFormat?: LocalThinkingFormat | undefined;
}

export interface ResolveProviderRuntimeParams {
  model: string;
  chatbotId?: string | undefined;
  enableRag?: boolean | undefined;
  agentId?: string | undefined;
}

export interface AIProvider {
  readonly id: AIProviderId;
  matchesModel(model: string): boolean;
  requiresChatbotId(model: string): boolean;
  resolveRuntimeCredentials(
    params: ResolveProviderRuntimeParams,
  ): Promise<ResolvedModelRuntimeCredentials>;
}
