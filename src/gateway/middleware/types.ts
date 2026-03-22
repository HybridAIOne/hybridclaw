import type { ChannelInfo } from '../../channels/channel.js';
import type { BuildMemoryPromptResult } from '../../memory/memory-service.js';
import type {
  Middleware,
  MiddlewareContext,
  MiddlewareSessionState,
  ToolMiddlewareContext,
} from '../../middleware/types.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import type {
  SessionContext,
  SessionSource,
} from '../../session/session-context.js';
import type {
  SessionExpiryEvaluation,
  SessionResetPolicy,
} from '../../session/session-reset.js';
import type { HistoryOptimizationStats } from '../../session/token-efficiency.js';
import type { Skill } from '../../skills/skills.js';
import type {
  ChatMessage,
  ContainerOutput,
  DelegationSideEffect,
  MediaContextItem,
  PendingApproval,
  Session,
  StoredMessage,
  ToolExecution,
  ToolProgressEvent,
} from '../../types.js';
import type { ProactiveMessagePayload } from '../fullauto.js';
import type {
  GatewayChatRequestBody,
  GatewayChatResult,
  GatewayCommandRequest,
} from '../gateway-types.js';

export interface MediaToolPolicy {
  blockedTools?: string[];
  prioritizeVisionTool: boolean;
}

export interface GatewayChatRequestLike extends GatewayChatRequestBody {
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  onApprovalProgress?: (approval: PendingApproval) => void;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  abortSignal?: AbortSignal;
  source?: string;
}

export type GatewaySessionBootstrapRequestLike = {
  sessionId: string;
  sessionMode?: 'new' | 'resume';
  guildId: string | null;
  channelId: string;
  userId?: string | null;
  agentId?: string | null;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
};

export interface GatewayPluginToolRequest
  extends GatewaySessionBootstrapRequestLike {
  toolName: string;
  args: Record<string, unknown>;
}

export interface GatewayScheduledTaskRequest
  extends GatewaySessionBootstrapRequestLike {
  taskId: number;
  prompt: string;
}

export interface PrepareSessionAutoResetParams {
  sessionId: string;
  channelId: string;
  agentId?: string | null;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
  policy: SessionResetPolicy;
}

export interface PrepareGatewaySessionRecordParams {
  request: GatewaySessionBootstrapRequestLike;
  pluginManager: PluginManager | null;
  sessionResetPolicy?: SessionResetPolicy;
}

export interface RecordSuccessfulTurnParams {
  sessionId: string;
  agentId: string;
  chatbotId: string;
  enableRag: boolean;
  model: string;
  channelId: string;
  runId: string;
  turnIndex: number;
  userId: string;
  username: string | null;
  canonicalScopeId: string;
  userContent: string;
  resultText: string;
  toolCallCount: number;
  startedAt: number;
}

export interface MaybeRecordGatewayRequestLogParams {
  sessionId: string;
  model: string;
  chatbotId: string;
  messages: ChatMessage[];
  status: 'success' | 'error';
  response?: string | null;
  error?: string | null;
  toolExecutions?: ToolExecution[];
  toolsUsed?: string[];
  durationMs: number;
}

export type DelegationMode = 'single' | 'parallel' | 'chain';

export interface NormalizedDelegationTaskLike {
  prompt: string;
  label?: string;
  model: string;
}

export interface NormalizedDelegationPlanLike {
  mode: DelegationMode;
  label?: string;
  tasks: NormalizedDelegationTaskLike[];
}

export interface NormalizeDelegationEffectResult {
  plan?: NormalizedDelegationPlanLike;
  error?: string;
}

export interface EnqueueDelegationFromSideEffectParams {
  plan: NormalizedDelegationPlanLike;
  parentSessionId: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  parentDepth: number;
}

export interface GatewayMiddlewareDependencies {
  maxHistoryMessages: number;
  prepareGatewaySessionRecord: (
    params: PrepareGatewaySessionRecordParams,
  ) => Promise<Session>;
  prepareSessionAutoReset: (
    params: PrepareSessionAutoResetParams,
  ) => Promise<SessionExpiryEvaluation | undefined>;
  shouldForceNewTuiSession: (
    req: Pick<GatewaySessionBootstrapRequestLike, 'channelId' | 'sessionMode'>,
  ) => boolean;
  resolveCanonicalContextScope: (
    session: Pick<Session, 'main_session_key' | 'session_key' | 'id'>,
  ) => string;
  recordSuccessfulTurn: (params: RecordSuccessfulTurnParams) => void;
  maybeRecordGatewayRequestLog: (
    params: MaybeRecordGatewayRequestLogParams,
  ) => void;
  normalizeDelegationEffect: (
    effect: DelegationSideEffect,
    fallbackModel: string,
  ) => NormalizeDelegationEffectResult;
  extractDelegationDepth: (sessionId: string) => number;
  enqueueDelegationFromSideEffect: (
    params: EnqueueDelegationFromSideEffectParams,
  ) => void;
}

export interface GatewayMiddlewareState extends MiddlewareSessionState {
  startedAt: number;
  runId: string;
  source: string;
  pluginManager: PluginManager | null;
  abortSignal?: AbortSignal;
  requestLoggingEnabled: boolean;
  session?: Session;
  agentId?: string;
  model?: string;
  chatbotId?: string | null;
  enableRag?: boolean;
  provider?: string;
  channelType?: string;
  channel?: ChannelInfo;
  sessionContext?: SessionContext;
  shouldEmitTools?: boolean;
  workspacePath?: string;
  media?: MediaContextItem[];
  mediaPolicy?: MediaToolPolicy;
  userTurnContent?: string;
  audioTranscriptCount?: number;
  canonicalContextScope?: string;
  turnIndex?: number;
  pluginsUsed?: string[];
  history?: StoredMessage[];
  mergedSessionSummary?: string | null;
  pluginPromptSummary?: string | null;
  canonicalPromptSummary?: string | null;
  canonicalRecentMessagesIncluded?: number;
  memoryContext?: BuildMemoryPromptResult;
  requestMessages?: ChatMessage[] | null;
  explicitSkillName?: string | null;
  historyStats?: HistoryOptimizationStats;
  historyLength?: number;
  skillCount?: number;
  skills?: Skill[];
  output?: ContainerOutput;
  firstTextDeltaMs?: number | null;
  durationMs?: number;
  effectiveUserContent?: string;
  toolExecutions?: ToolExecution[];
  observedSkillName?: string | null;
  usagePayload?: Record<string, number | boolean>;
  resultText?: string;
  errorMessage?: string;
  clarificationRequested?: boolean;
  turnLoopRepeatCount?: number;
  turnLoopAction?: 'warn' | 'force-stop' | null;
  storedTurnMessages?: StoredMessage[];
  finalResult?: GatewayChatResult;
}

export interface GatewayMiddlewareContext
  extends MiddlewareContext<GatewayMiddlewareState> {
  request: GatewayChatRequestLike;
}

export interface GatewayCommandMiddlewareState extends MiddlewareSessionState {
  pluginManager: PluginManager | null;
  session?: Session;
}

export interface GatewayCommandMiddlewareContext
  extends MiddlewareContext<GatewayCommandMiddlewareState> {
  request: GatewayCommandRequest;
}

export interface GatewayPluginToolMiddlewareState
  extends MiddlewareSessionState {
  pluginManager: PluginManager;
  session?: Session;
}

export interface GatewayPluginToolMiddlewareContext
  extends MiddlewareContext<GatewayPluginToolMiddlewareState> {
  request: GatewayPluginToolRequest;
}

export interface GatewayScheduledTaskMiddlewareState
  extends MiddlewareSessionState {
  pluginManager: PluginManager | null;
  session?: Session;
}

export interface GatewayScheduledTaskMiddlewareContext
  extends MiddlewareContext<GatewayScheduledTaskMiddlewareState> {
  request: GatewayScheduledTaskRequest;
}

export type GatewayChainMiddleware = Middleware<
  GatewayMiddlewareState,
  GatewayMiddlewareContext,
  ToolMiddlewareContext<GatewayMiddlewareState>
>;

export type GatewayCommandChainMiddleware = Middleware<
  GatewayCommandMiddlewareState,
  GatewayCommandMiddlewareContext,
  ToolMiddlewareContext<GatewayCommandMiddlewareState>
>;

export type GatewayPluginToolChainMiddleware = Middleware<
  GatewayPluginToolMiddlewareState,
  GatewayPluginToolMiddlewareContext,
  ToolMiddlewareContext<GatewayPluginToolMiddlewareState>
>;

export type GatewayScheduledTaskChainMiddleware = Middleware<
  GatewayScheduledTaskMiddlewareState,
  GatewayScheduledTaskMiddlewareContext,
  ToolMiddlewareContext<GatewayScheduledTaskMiddlewareState>
>;

export type GatewaySessionContextSource = Pick<
  SessionSource,
  'channelKind' | 'chatId' | 'chatType' | 'userId' | 'userName' | 'guildId'
>;
