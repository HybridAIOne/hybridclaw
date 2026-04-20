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

export interface ContentImageGenerationConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  defaultCount: number;
  defaultAspectRatio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
  defaultResolution: '1K' | '2K' | '4K';
  defaultOutputFormat: 'png' | 'jpeg';
  timeoutMs: number;
}

export interface ContentSpeechConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  defaultVoice: string;
  defaultOutputFormat: 'mp3' | 'wav' | 'opus';
  defaultSpeed: number;
  maxChars: number;
  timeoutMs: number;
}

export interface ContentTranscriptionConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  defaultLanguage: string;
  defaultPrompt: string;
  maxBytes: number;
  timeoutMs: number;
}

export interface ContentToolConfig {
  imageGeneration: ContentImageGenerationConfig;
  speech: ContentSpeechConfig;
  transcription: ContentTranscriptionConfig;
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
  provider?: ProviderKind;
  providerMethod?: string;
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
  persistBashState?: boolean;
  runtimeEnv?: Record<string, string>;
  escalationTarget?: EscalationTarget;
  contentTools?: ContentToolConfig;
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
