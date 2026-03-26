import type { ChatMessage } from './api.js';
import type { MemoryCitation } from './memory.js';
import type { ScheduleSideEffect } from './scheduler.js';
import type { TokenUsageStats } from './usage.js';

export interface MediaContextItem {
  path: string | null;
  url: string;
  originalUrl: string;
  mimeType: string | null;
  sizeBytes: number;
  filename: string;
}

export interface McpServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface RuntimeToolSchemaProperty {
  type: string | string[];
  description?: string;
  items?: RuntimeToolSchemaProperty;
  properties?: Record<string, RuntimeToolSchemaProperty>;
  required?: string[];
  enum?: string[];
  minItems?: number;
  maxItems?: number;
}

export interface RuntimeToolSchema {
  type: 'object';
  properties: Record<string, RuntimeToolSchemaProperty>;
  required: string[];
}

export interface PluginRuntimeToolDefinition {
  name: string;
  description: string;
  parameters: RuntimeToolSchema;
}

export interface TaskModelPolicy {
  provider?:
    | 'hybridai'
    | 'openai-codex'
    | 'openrouter'
    | 'ollama'
    | 'lmstudio'
    | 'vllm';
  baseUrl?: string;
  apiKey?: string;
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
  model: string;
  chatbotId?: string;
  maxTokens?: number;
  error?: string;
}

export const TASK_MODEL_KEYS = [
  'vision',
  'compression',
  'web_extract',
  'session_search',
  'skills_hub',
  'mcp',
  'flush_memories',
] as const;

export type TaskModelKey = (typeof TASK_MODEL_KEYS)[number];

export interface TaskModelPolicies {
  vision?: TaskModelPolicy;
  compression?: TaskModelPolicy;
  web_extract?: TaskModelPolicy;
  session_search?: TaskModelPolicy;
  skills_hub?: TaskModelPolicy;
  mcp?: TaskModelPolicy;
  flush_memories?: TaskModelPolicy;
}

export interface ContextGuardConfig {
  enabled: boolean;
  perResultShare: number;
  compactionRatio: number;
  overflowRatio: number;
  maxRetries: number;
}

export interface ContainerInput {
  sessionId: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  apiKey: string;
  baseUrl: string;
  provider?:
    | 'hybridai'
    | 'openai-codex'
    | 'openrouter'
    | 'ollama'
    | 'lmstudio'
    | 'vllm';
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
  maxTokens?: number;
  channelId: string;
  configuredDiscordChannels?: string[];
  scheduledTasks?: {
    id: number;
    cronExpr: string;
    runAt: string | null;
    everyMs: number | null;
    prompt: string;
    enabled: number;
    lastRun: string | null;
    createdAt: string;
  }[];
  allowedTools?: string[];
  blockedTools?: string[];
  media?: MediaContextItem[];
  audioTranscriptsPrepended?: boolean;
  pluginTools?: PluginRuntimeToolDefinition[];
  mcpServers?: Record<string, McpServerConfig>;
  taskModels?: TaskModelPolicies;
  contextGuard?: ContextGuardConfig;
  webSearch?: {
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
  };
}

export interface ToolExecution {
  name: string;
  arguments: string;
  result: string;
  durationMs: number;
  isError?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  approvalTier?: 'green' | 'yellow' | 'red';
  approvalBaseTier?: 'green' | 'yellow' | 'red';
  approvalDecision?:
    | 'auto'
    | 'implicit'
    | 'approved_once'
    | 'approved_session'
    | 'approved_agent'
    | 'approved_fullauto'
    | 'promoted'
    | 'required'
    | 'denied';
  approvalActionKey?: string;
  approvalIntent?: string;
  approvalReason?: string;
  approvalRequestId?: string;
  approvalExpiresAt?: number;
  approvalAllowSession?: boolean;
  approvalAllowAgent?: boolean;
}

export interface PendingApproval {
  approvalId: string;
  prompt: string;
  intent: string;
  reason: string;
  allowSession: boolean;
  allowAgent: boolean;
  expiresAt: number | null;
}

export interface ToolProgressEvent {
  sessionId: string;
  toolName: string;
  phase: 'start' | 'finish';
  preview?: string;
  durationMs?: number;
}

export interface ArtifactMetadata {
  path: string;
  filename: string;
  mimeType: string;
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

export interface DelegationTaskSpec {
  prompt: string;
  label?: string;
  model?: string;
}

export interface DelegationSideEffect {
  action: 'delegate';
  mode?: 'single' | 'parallel' | 'chain';
  prompt?: string;
  label?: string;
  model?: string;
  tasks?: DelegationTaskSpec[];
  chain?: DelegationTaskSpec[];
}
