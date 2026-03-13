export interface ProviderContextValidationParams {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  chatbotId?: string;
  toolName: string;
  missingContextSource?: 'active request';
}

export declare function getProviderContextError(
  params: ProviderContextValidationParams,
): string | null;
