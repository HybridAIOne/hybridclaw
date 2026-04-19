import type { ChatMessage } from './api.js';
import type {
  ArtifactMetadata,
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

export interface WebSearchConfig {
  provider:
    | 'auto'
    | 'brave'
    | 'perplexity'
    | 'tavily'
    | 'duckduckgo'
    | 'searxng';
  fallbackProviders: (
    | 'brave'
    | 'perplexity'
    | 'tavily'
    | 'duckduckgo'
    | 'searxng'
  )[];
  defaultCount: number;
  cacheTtlMinutes: number;
  searxngBaseUrl: string;
  tavilySearchDepth: 'basic' | 'advanced';
}

export interface ProviderCredentialPoolEntryInput {
  id: string;
  label: string;
  apiKey: string;
}

export interface ProviderCredentialPoolInput {
  rotation: 'least_used';
  entries: ProviderCredentialPoolEntryInput[];
}

export interface ModelRoutingRouteInput {
  provider?: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
  maxTokens?: number;
  credentialPool?: ProviderCredentialPoolInput;
}

export interface ModelRoutingInput {
  routes: ModelRoutingRouteInput[];
  adaptiveContextTierDowngradeOn429?: boolean;
}

export interface ContainerInput {
  sessionId: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  apiKey: string;
  baseUrl: string;
  provider?: ProviderKind;
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
  gatewayBaseUrl?: string;
  gatewayApiToken?: string;
  model: string;
  ralphMaxIterations?: number | null;
  fullAutoEnabled?: boolean;
  fullAutoNeverApproveTools?: string[];
  skipContainerSystemPrompt?: boolean;
  streamTextDeltas?: boolean;
  maxTokens?: number;
  channelId: string;
  configuredDiscordChannels?: string[];
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
  modelRouting?: ModelRoutingInput;
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
