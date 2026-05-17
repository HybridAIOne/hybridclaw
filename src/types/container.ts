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
  apiKey?: string;
  baseUrl?: string;
  audioModel?: string;
  imageModel?: string;
  videoModel?: string;
}

export interface ProviderCredentials {
  speechToText?: {
    defaultProvider?: string;
  };
  openai?: ProviderCredential;
  gemini?: ProviderCredential;
  xai?: ProviderCredential;
  bfl?: ProviderCredential;
  deepgram?: ProviderCredential;
  assemblyai?: ProviderCredential;
}

export interface ContainerInput {
  healthCheck?: {
    nonce: string;
  };
  sessionId: string;
  agentId?: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  apiKey: string;
  baseUrl: string;
  provider?: ProviderKind;
  providerMethod?: string;
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
  gatewayBaseUrl?: string;
  gatewayApiToken?: string;
  browserProvider?: string;
  model: string;
  ralphMaxIterations?: number | null;
  fullAutoEnabled?: boolean;
  fullAutoNeverApproveTools?: string[];
  scheduleSideEffectsEnabled?: boolean;
  skipContainerSystemPrompt?: boolean;
  streamTextDeltas?: boolean;
  debugModelResponses?: boolean;
  maxTokens?: number;
  channelId: string;
  configuredDiscordChannels?: string[];
  activeMessageChannels?: string[];
  scheduledTasks?: ScheduledTaskInput[];
  allowedTools?: string[];
  blockedTools?: string[];
  media?: MediaContextItem[];
  audioTranscriptsPrepended?: boolean;
  pluginTools?: PluginRuntimeToolDefinition[];
  mcpServers?: Record<string, McpServerConfig>;
  taskModels?: TaskModelPolicies;
  contextGuard?: ContextGuardConfig;
  webSearch?: WebSearchConfig;
  providerCredentials?: ProviderCredentials;
  persistBashState?: boolean;
  runtimeEnv?: Record<string, string>;
  escalationTarget?: EscalationTarget;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  artifacts?: ArtifactMetadata[];
  memoryCitations?: MemoryCitation[];
  toolExecutions?: ToolExecution[];
  pendingApproval?: PendingApproval;
  tokenUsage?: TokenUsageStats;
  error?: string;
  effectiveUserPrompt?: string;
  sideEffects?: {
    schedules?: ScheduleSideEffect[];
    delegations?: DelegationSideEffect[];
  };
}
