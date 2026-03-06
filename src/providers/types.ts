export type AIProviderId = 'hybridai' | 'openai-codex' | 'anthropic';
export type RuntimeProviderId = 'hybridai' | 'openai-codex';

export interface ResolvedModelRuntimeCredentials {
  provider: RuntimeProviderId;
  apiKey: string;
  baseUrl: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders: Record<string, string>;
  agentId: string;
  accountId?: string;
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
