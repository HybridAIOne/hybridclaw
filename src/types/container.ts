import type { ApprovalMode } from '@hybridclaw/shared/approval-mode';
import type {
  ApprovalReplyContext,
  ApprovalReplyInterpretation,
} from '@hybridclaw/shared/approval-reply';
import type {
  FileWriteGuardContext,
  FileWriteGuardReceipt,
} from '@hybridclaw/shared/file-write-guard';
import type { ReasoningEffort } from '@hybridclaw/shared/reasoning-effort';
import type { SessionAttachmentAccess } from '@hybridclaw/shared/session-attachment-access';
import type { SessionSkillCatalogEntry } from '@hybridclaw/shared/skill-catalog';
import type { ToolCallLimits } from '@hybridclaw/shared/tool-call-limits';
import type { RecoveryDisposition } from '@hybridclaw/shared/turn-checkpoint';
import type { WebSearchConfig } from '@hybridclaw/shared/web-search-config';
import type { ChatMessage } from './api.js';
import type {
  ArtifactMetadata,
  EscalationTarget,
  PendingApproval,
  PluginRuntimeToolDefinition,
  ToolExecution,
} from './execution.js';
import type { MemoryCitation } from './memory.js';
import type { ModelBehavior } from './model-behavior.js';
import type {
  ContextGuardConfig,
  McpServerConfig,
  ProviderKind,
  TaskModelPolicies,
} from './models.js';
import type { DelegationSideEffect } from './side-effects.js';
import type { TokenUsageStats } from './usage.js';

export interface MediaContextItem {
  path: string | null;
  url: string;
  originalUrl: string;
  mimeType: string | null;
  sizeBytes: number;
  filename: string;
  /**
   * Set when the channel could not download the attachment, so `path` is
   * null and the content never reached the agent. The prompt uses it to tell
   * the model the file did not arrive instead of leaving a dead URL behind.
   */
  unavailableReason?: string | null;
}

export type { SessionSkillCatalogEntry } from '@hybridclaw/shared/skill-catalog';
export type { WebSearchConfig } from '@hybridclaw/shared/web-search-config';

export interface AddressEnvelope {
  to: string | string[];
  from?: string | null;
  fanoutAlias?: 'team' | 'all';
}

export interface ContainerInput
  extends SessionAttachmentAccess,
    ApprovalReplyContext,
    FileWriteGuardContext,
    ToolCallLimits {
  healthCheck?: {
    nonce: string;
  };
  sessionId: string;
  runId?: string;
  /** Names this request's reply file; see packages/shared/src/ipc-output-files.ts. */
  requestId?: string;
  agentId?: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  apiKey: string;
  /**
   * Per-worker secret that authenticates later IPC inputs. Delivered only in
   * the first stdin payload and never written to a file (see
   * packages/shared/src/ipc-input-auth.ts); stripped by buildRedactedInput.
   */
  ipcAuthSecret?: string;
  baseUrl: string;
  provider?: ProviderKind;
  providerMethod?: string;
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  modelBehavior?: ModelBehavior;
  thinkingFormat?: 'qwen';
  reasoningEffort?: ReasoningEffort;
  gatewayBaseUrl?: string;
  gatewayApiToken?: string;
  browserProvider?: string;
  browserAllowPrivateNetwork?: boolean;
  model: string;
  addressEnvelope?: AddressEnvelope;
  ralphMaxIterations?: number | null;
  disabledSafetyRules?: string[];
  approvalMode?: ApprovalMode;
  fullAutoNeverApproveTools?: string[];
  scheduleSideEffectsEnabled?: boolean;
  skipContainerSystemPrompt?: boolean;
  streamTextDeltas?: boolean;
  debugModelResponses?: boolean;
  maxTokens?: number;
  channelId: string;
  /** The app that sent the turn when it is not the browser chat. */
  client?: string;
  configuredDiscordChannels?: string[];
  activeMessageChannels?: string[];
  /** The email channel's From address for this agent; shown on send approvals. */
  emailSender?: string;
  skillCatalog?: SessionSkillCatalogEntry[];
  localToolMode?: 'full' | 'starred';
  localStarterTools?: string[];
  mcpToolMode?: 'full' | 'deferred';
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
}

export interface ContainerOutput
  extends FileWriteGuardContext,
    FileWriteGuardReceipt {
  recovery?: RecoveryDisposition;
  approvalReply?: ApprovalReplyInterpretation;
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  outputPresentation?: OutputPresentationMetadata;
  artifacts?: ArtifactMetadata[];
  memoryCitations?: MemoryCitation[];
  toolExecutions?: ToolExecution[];
  toolHistory?: ChatMessage[];
  toolHistoryForReplay?: ChatMessage[];
  /** Results sent as file references; model input retains the complete text. */
  spilledToolCallIds?: string[];
  /** Steering notes the model was shown during the turn, in order. */
  steerNoteIds?: string[];
  pendingApproval?: PendingApproval;
  tokenUsage?: TokenUsageStats;
  error?: string;
  /** What kind of error, for clients that word it themselves. */
  errorCode?: AgentErrorCode;
  effectiveUserPrompt?: string;
  sideEffects?: {
    delegations?: DelegationSideEffect[];
  };
}

/** `busy`: every agent process was taken, so the turn never started. */
export type AgentErrorCode = 'busy';

export type OutputSegmentKind =
  | 'draft'
  | 'final'
  | 'tool_request'
  | 'approval'
  | 'status';
export type OutputDisplaySurface = 'none' | 'assistant_bubble' | 'approval';

export interface OutputPresentationMetadata {
  segmentKind: OutputSegmentKind;
  visible: boolean;
  displaySurface: OutputDisplaySurface;
}
