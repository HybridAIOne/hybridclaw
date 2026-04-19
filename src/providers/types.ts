import type { LocalThinkingFormat } from './local-types.js';
import type { AIProviderId, RuntimeProviderId } from './provider-ids.js';

export type { AIProviderId, RuntimeProviderId } from './provider-ids.js';

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
  maxTokens?: number;
  thinkingFormat?: LocalThinkingFormat;
}

export interface ResolvedCredentialPoolEntry {
  id: string;
  label: string;
  apiKey: string;
}

export interface ResolvedCredentialPool {
  rotation: 'least_used';
  entries: ResolvedCredentialPoolEntry[];
}

export interface ResolvedModelRuntimeRoute
  extends ResolvedModelRuntimeCredentials {
  model: string;
  maxTokens?: number;
  credentialPool?: ResolvedCredentialPool;
}

export interface ResolvedModelRoutingPlan {
  routes: ResolvedModelRuntimeRoute[];
  adaptiveContextTierDowngradeOn429: boolean;
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
