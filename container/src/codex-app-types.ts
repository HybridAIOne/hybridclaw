import type { ContainerInput } from './types.js';

export interface CodexMcpContext {
  provider?: ContainerInput['provider'];
  providerMethod?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  chatbotId?: string;
  requestHeaders?: Record<string, string>;
  maxTokens?: number;
  modelBehavior?: ContainerInput['modelBehavior'];
  debugModelResponses?: boolean;
  gatewayBaseUrl?: string;
  gatewayApiToken?: string;
  channelId?: string;
  configuredDiscordChannels?: string[];
  taskModels?: ContainerInput['taskModels'];
  media?: ContainerInput['media'];
  webSearch?: ContainerInput['webSearch'];
  providerCredentials?: ContainerInput['providerCredentials'];
}
