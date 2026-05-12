export interface ProviderContextValidationParams {
  provider?: string | undefined;
  providerMethod?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  chatbotId?: string | undefined;
  toolName: string;
  missingContextSource?: 'active request' | undefined;
}

export declare function getProviderContextError(
  params: ProviderContextValidationParams,
): string | null;
