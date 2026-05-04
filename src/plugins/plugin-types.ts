import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type {
  AgentTurnContext,
  ClassifierMiddlewareSkill,
  MiddlewareDecision,
} from '../agent/middleware.js';
import type { ChannelInfo } from '../channels/channel.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { GatewayChatResult } from '../gateway/gateway-types.js';
import type { AIProvider } from '../providers/types.js';
import type { ChatMessage } from '../types/api.js';
import type { MediaContextItem } from '../types/container.js';
import type { ArtifactMetadata, ToolExecution } from '../types/execution.js';
import type { McpServerConfig } from '../types/models.js';
import type { StoredMessage } from '../types/session.js';

export type PluginKind =
  | 'memory'
  | 'provider'
  | 'channel'
  | 'tool'
  | 'prompt-hook'
  | 'output-guard'
  | 'middleware';

export type PluginRegistrationMode = 'full' | 'discovery';
export type PluginDiscoverySource = 'home' | 'project' | 'config';

export interface PluginInstallSpec {
  kind: 'npm' | 'node' | 'download';
  package?: string;
  url?: string;
}

export interface PluginPackageDependency {
  package: string;
}

export interface PluginExternalDependency {
  name: string;
  check: string;
  installHint?: string;
  installUrl?: string;
}

export interface PluginConfigUiHint {
  label?: string;
  placeholder?: string;
  help?: string;
}

export interface PluginBinaryRequirement {
  name: string;
  configKey?: string;
  installHint?: string;
  installUrl?: string;
}

export interface PluginConfigSchema {
  [key: string]: unknown;
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, PluginConfigSchema>;
  required?: string[];
  items?: PluginConfigSchema | PluginConfigSchema[];
  additionalProperties?: boolean | PluginConfigSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

export interface PluginManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  kind?: PluginKind;
  memoryProvider?: boolean;
  author?: string;
  entrypoint?: string;
  requires?: {
    bins?: PluginBinaryRequirement[];
    env?: string[];
    node?: string;
  };
  credentials?: string[];
  install?: PluginInstallSpec[];
  pipDependencies?: PluginPackageDependency[];
  nodeDependencies?: PluginPackageDependency[];
  externalDependencies?: PluginExternalDependency[];
  configSchema?: PluginConfigSchema;
  configUiHints?: Record<string, PluginConfigUiHint>;
}

export interface PluginCandidate {
  id: string;
  dir: string;
  entrypoint: string;
  manifestPath: string;
  manifest: PluginManifest;
  source: PluginDiscoverySource;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface PluginRuntime {
  readonly cwd: string;
  readonly homeDir: string;
  readonly installRoot: string;
  readonly runtimeConfigPath: string;
}

export type PluginLogger = Logger;

export interface PluginToolSchemaProperty {
  type: string | string[];
  description?: string;
  items?: PluginToolSchemaProperty;
  properties?: Record<string, PluginToolSchemaProperty>;
  required?: string[];
  enum?: string[];
  minItems?: number;
  maxItems?: number;
}

export interface PluginToolSchema {
  type: 'object';
  properties: Record<string, PluginToolSchemaProperty>;
  required: string[];
}

export interface PluginRuntimeToolDefinition {
  name: string;
  description: string;
  parameters: PluginToolSchema;
}

export interface PluginToolHandlerContext {
  sessionId: string;
  channelId: string;
  pluginId: string;
  logger: PluginLogger;
}

export interface PluginToolDefinition extends PluginRuntimeToolDefinition {
  handler: (
    args: Record<string, unknown>,
    context: PluginToolHandlerContext,
  ) => Promise<unknown> | unknown;
}

export interface PluginPromptBuildContext {
  sessionId: string;
  userId: string;
  agentId: string;
  channelId: string;
  workspacePath?: string;
  recentMessages: StoredMessage[];
  extraContext: string[];
}

export interface PluginMemoryBehavior {
  replacesBuiltInMemory: boolean;
}

export interface PluginPromptContextResult extends PluginMemoryBehavior {
  sections: string[];
  pluginIds: string[];
}

export interface PluginTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  modelCalls: number;
}

export interface PluginAgentEndContext {
  sessionId: string;
  userId: string;
  agentId: string;
  channelId: string;
  messages: StoredMessage[];
  resultText: string;
  toolNames: string[];
  model?: string;
  durationMs?: number;
  tokenUsage?: PluginTokenUsage;
}

export interface PluginToolHookContext {
  sessionId: string;
  channelId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface PluginAfterToolCallContext extends PluginToolHookContext {
  result: string;
  isError: boolean;
}

export interface PluginSessionResetContext {
  previousSessionId: string;
  sessionId: string;
  userId: string;
  agentId: string;
  channelId: string;
  reason: 'clear' | 'reset' | 'auto-reset' | 'workspace-reset';
}

export interface PluginCompactionContext {
  sessionId: string;
  agentId: string;
  channelId: string;
  summary: string | null;
  olderMessages: StoredMessage[];
}

export interface PluginMemoryFlushContext {
  sessionId: string;
  agentId: string;
  channelId: string;
  olderMessages: StoredMessage[];
}

export type PluginMemoryWriteAction = 'append' | 'write' | 'replace' | 'remove';

export interface PluginMemoryWriteContext {
  sessionId: string;
  agentId: string;
  channelId: string;
  action: PluginMemoryWriteAction;
  memoryFilePath: string;
  arguments: Record<string, unknown>;
  result: string;
  content?: string;
  oldText?: string;
  newText?: string;
}

export interface PluginGatewayLifecycleContext {
  startedAt: string;
}

export type PluginHookName =
  | 'session_start'
  | 'session_end'
  | 'session_reset'
  | 'before_prompt_build'
  | 'before_agent_start'
  | 'agent_end'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'before_compaction'
  | 'after_compaction'
  | 'memory_write'
  | 'memory_flush'
  | 'gateway_start'
  | 'gateway_stop';

export interface PluginHookHandlerMap {
  session_start: (context: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
    workspacePath?: string;
  }) => Promise<void> | void;
  session_end: (context: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
    workspacePath?: string;
  }) => Promise<void> | void;
  session_reset: (context: PluginSessionResetContext) => Promise<void> | void;
  before_prompt_build: (
    context: PluginPromptBuildContext,
  ) => Promise<void> | void;
  before_agent_start: (context: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
    model?: string;
  }) => Promise<void> | void;
  agent_end: (context: PluginAgentEndContext) => Promise<void> | void;
  pre_tool_use: (context: PluginToolHookContext) => Promise<void> | void;
  post_tool_use: (context: PluginAfterToolCallContext) => Promise<void> | void;
  before_tool_call: (context: PluginToolHookContext) => Promise<void> | void;
  after_tool_call: (
    context: PluginAfterToolCallContext,
  ) => Promise<void> | void;
  before_compaction: (context: PluginCompactionContext) => Promise<void> | void;
  after_compaction: (context: PluginCompactionContext) => Promise<void> | void;
  memory_write: (context: PluginMemoryWriteContext) => Promise<void> | void;
  memory_flush: (context: PluginMemoryFlushContext) => Promise<void> | void;
  gateway_start: (
    context: PluginGatewayLifecycleContext,
  ) => Promise<void> | void;
  gateway_stop: (
    context: PluginGatewayLifecycleContext,
  ) => Promise<void> | void;
}

export interface PluginPromptHook {
  id: string;
  priority?: number;
  render: (
    context: PluginPromptBuildContext,
  ) => Promise<string | null> | string | null;
}

export interface PluginOutputGuardContext {
  sessionId: string;
  userId: string;
  agentId: string;
  channelId: string;
  model?: string;
  workspacePath?: string;
  messages?: ChatMessage[];
  userContent: string;
  resultText: string;
  toolExecutions?: ToolExecution[];
  skill?: AgentTurnContext['skill'];
}

export type PluginOutputGuardDecision =
  | { action: 'allow' }
  | { action: 'warn'; reason: string }
  | { action: 'rewrite'; text: string; reason?: string }
  | { action: 'block'; reason: string };

export interface PluginOutputGuard {
  id: string;
  priority?: number;
  predicate?: (context: PluginOutputGuardContext) => Promise<boolean> | boolean;
  inspect: (
    context: PluginOutputGuardContext,
  ) =>
    | Promise<PluginOutputGuardDecision | null | undefined>
    | PluginOutputGuardDecision
    | null
    | undefined;
}

export interface PluginOutputGuardEvent {
  pluginId: string;
  guardId: string;
  action: 'allow' | 'rewrite' | 'block' | 'warn';
  reason?: string;
  before?: string;
  after?: string;
}

export interface PluginOutputGuardOutcome {
  resultText: string;
  blocked: boolean;
  events: PluginOutputGuardEvent[];
}

export type PluginAgentTurnContext = AgentTurnContext & {
  userId: string;
};

export type PluginMiddlewareDecision = MiddlewareDecision;

export interface PluginMiddlewareSkill
  extends ClassifierMiddlewareSkill<PluginAgentTurnContext> {}

export interface MemoryLayerPlugin {
  id: string;
  priority: number;
  replacesBuiltInMemory?: boolean;
  getContextForPrompt?: (params: {
    sessionId: string;
    userId: string;
    agentId: string;
    workspacePath?: string;
    recentMessages: StoredMessage[];
  }) => Promise<string | null>;
  onTurnComplete?: (params: {
    sessionId: string;
    userId: string;
    agentId: string;
    workspacePath?: string;
    messages: StoredMessage[];
  }) => Promise<void>;
  onSessionReset?: (params: {
    sessionId: string;
    userId: string;
  }) => Promise<void>;
  query?: (params: { userId: string; query: string }) => Promise<string>;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
}

export interface PluginCommandDefinition {
  name: string;
  description?: string;
  handler: (
    args: string[],
    context: {
      sessionId: string;
      channelId: string;
      userId?: string | null;
      username?: string | null;
      guildId?: string | null;
      workspacePath?: string;
    },
  ) => Promise<unknown> | unknown;
}

export interface PluginService {
  id: string;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
}

export interface PluginInboundProactiveMessage {
  text: string;
  artifacts?: ArtifactMetadata[];
}

export interface PluginDispatchInboundMessageRequest {
  sessionId: string;
  sessionMode?: 'new' | 'resume';
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string | null;
  content: string;
  media?: MediaContextItem[];
  agentId?: string | null;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
  onProactiveMessage?: (
    message: PluginInboundProactiveMessage,
  ) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

export interface PluginInboundWebhookContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pluginId: string;
  webhookName: string;
  method: 'GET' | 'POST';
  path: string;
  logger: PluginLogger;
}

export interface PluginInboundWebhookDefinition {
  name: string;
  description?: string;
  method?: 'GET' | 'POST';
  handler: (context: PluginInboundWebhookContext) => Promise<void> | void;
}

export interface HybridClawPluginApi {
  readonly pluginId: string;
  readonly pluginDir: string;
  readonly registrationMode: PluginRegistrationMode;
  readonly config: Readonly<RuntimeConfig>;
  readonly pluginConfig: Readonly<Record<string, unknown>>;
  readonly logger: PluginLogger;
  readonly runtime: PluginRuntime;
  registerMemoryLayer(layer: MemoryLayerPlugin): void;
  registerProvider(provider: AIProvider): void;
  registerChannel(channel: ChannelInfo): void;
  registerTool(tool: PluginToolDefinition): void;
  registerPromptHook(hook: PluginPromptHook): void;
  registerMiddleware(middleware: PluginMiddlewareSkill): void;
  registerOutputGuard(guard: PluginOutputGuard): void;
  registerCommand(cmd: PluginCommandDefinition): void;
  registerService(svc: PluginService): void;
  registerInboundWebhook(webhook: PluginInboundWebhookDefinition): void;
  dispatchInboundMessage(
    request: PluginDispatchInboundMessageRequest,
  ): Promise<GatewayChatResult>;
  on<K extends PluginHookName>(
    event: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ): void;
  resolvePath(relative: string): string;
  getCredential(key: string): string | undefined;
  getMcpServerConfig(name: string): Readonly<McpServerConfig> | null;
  writeConfigValue(key: string, rawValue: string): Promise<void>;
  unsetConfigValue(key: string): Promise<void>;
  resolveSessionAgentId(sessionId: string): string;
  getSessionInfo(sessionId: string): {
    sessionId: string;
    agentId: string;
    userId: string | null;
    workspacePath: string;
    workspaceRoot: string;
  };
  getSessionMessages(sessionId: string, limit?: number): StoredMessage[];
}

export interface HybridClawPluginDefinition {
  id: string;
  name?: string;
  version?: string;
  kind?: PluginKind;
  configSchema?: PluginConfigSchema;
  register: (api: HybridClawPluginApi) => void;
}

export interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  candidate: PluginCandidate;
  enabled: boolean;
  status: 'loaded' | 'failed';
  error?: string;
  toolsRegistered: string[];
  hooksRegistered: string[];
  definition?: HybridClawPluginDefinition;
  api?: HybridClawPluginApi;
}

export interface PluginSummary {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  source: PluginDiscoverySource;
  enabled: boolean;
  error?: string;
  commands: string[];
  tools: string[];
  hooks: string[];
}
