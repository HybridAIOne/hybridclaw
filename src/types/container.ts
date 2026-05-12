import type { WebSearchConfig } from '../../container/shared/web-search-config.js';
import type { ChatMessage } from './api.js';
import type {
  ArtifactMetadata,
  EscalationTarget,
  PendingApproval,
  PluginRuntimeToolDefinition,
  ToolExecution,
} from './execution.js';
import type { MemoryCitation } from './memory.js';
import type {
  ContextGuardConfig,
  McpServerConfig,
  ProviderKind,
  TaskModelPolicies,
} from './models.js';
import type { ScheduledTaskInput } from './scheduler.js';
import type {
  DelegationSideEffect,
  ScheduleSideEffect,
} from './side-effects.js';
import type { TokenUsageStats } from './usage.js';

export interface MediaContextItem {
  path: string | null;
  url: string;
  originalUrl: string;
  mimeType: string | null;
  sizeBytes: number;
  filename: string;
}

export type { WebSearchConfig } from '../../container/shared/web-search-config.js';

export interface ProviderCredential {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  imageModel?: string | undefined;
  videoModel?: string | undefined;
}

export interface ProviderCredentials {
  openai?: ProviderCredential | undefined;
  gemini?: ProviderCredential | undefined;
  xai?: ProviderCredential | undefined;
  bfl?: ProviderCredential | undefined;
}

export interface ContainerInput {
  healthCheck?: {
    nonce: string;
  };
  sessionId: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  apiKey: string;
  baseUrl: string;
  provider?: ProviderKind | undefined;
  providerMethod?: string | undefined;
  requestHeaders?: Record<string, string> | undefined;
  isLocal?: boolean | undefined;
  contextWindow?: number | undefined;
  thinkingFormat?: 'qwen' | undefined;
  gatewayBaseUrl?: string | undefined;
  gatewayApiToken?: string | undefined;
  model: string;
  ralphMaxIterations?: number | null | undefined;
  fullAutoEnabled?: boolean | undefined;
  fullAutoNeverApproveTools?: string[] | undefined;
  skipContainerSystemPrompt?: boolean | undefined;
  streamTextDeltas?: boolean | undefined;
  debugModelResponses?: boolean | undefined;
  maxTokens?: number | undefined;
  channelId: string;
  configuredDiscordChannels?: string[] | undefined;
  activeMessageChannels?: string[] | undefined;
  scheduledTasks?: ScheduledTaskInput[] | undefined;
  allowedTools?: string[] | undefined;
  blockedTools?: string[] | undefined;
  media?: MediaContextItem[] | undefined;
  audioTranscriptsPrepended?: boolean | undefined;
  pluginTools?: PluginRuntimeToolDefinition[] | undefined;
  mcpServers?: Record<string, McpServerConfig> | undefined;
  taskModels?: TaskModelPolicies | undefined;
  contextGuard?: ContextGuardConfig | undefined;
  webSearch?: WebSearchConfig | undefined;
  providerCredentials?: ProviderCredentials | undefined;
  persistBashState?: boolean | undefined;
  runtimeEnv?: Record<string, string> | undefined;
  escalationTarget?: EscalationTarget | undefined;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  artifacts?: ArtifactMetadata[] | undefined;
  memoryCitations?: MemoryCitation[] | undefined;
  toolExecutions?: ToolExecution[] | undefined;
  pendingApproval?: PendingApproval | undefined;
  tokenUsage?: TokenUsageStats | undefined;
  error?: string | undefined;
  effectiveUserPrompt?: string | undefined;
  sideEffects?:
    | {
        schedules?: ScheduleSideEffect[] | undefined;
        delegations?: DelegationSideEffect[] | undefined;
      }
    | undefined;
}
