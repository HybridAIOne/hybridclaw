/**
 * Worker protocol data shares usage snapshots with gateway recovery.
 * Provider parsing belongs to token-usage.ts; these types grant no tool
 * authority and do not define a second accounting schema.
 */
import type {
  ApprovalMode,
  ApprovalObservation,
} from '@hybridclaw/shared/approval-mode';
import type {
  ApprovalReplyContext,
  ApprovalReplyInterpretation,
} from '@hybridclaw/shared/approval-reply';
import type { ApprovalRule } from '@hybridclaw/shared/approval-rules';
import type { BoostOffer, BoostPrompt } from '@hybridclaw/shared/boost-offer';
import type { ConnectorApproval } from '@hybridclaw/shared/connector-approval';
import type {
  FileWriteGuardContext,
  FileWriteGuardReceipt,
} from '@hybridclaw/shared/file-write-guard';
import type { RuntimeProviderId } from '@hybridclaw/shared/provider-ids';
import type { ReasoningEffort } from '@hybridclaw/shared/reasoning-effort';
import type { SessionAttachmentAccess } from '@hybridclaw/shared/session-attachment-access';
import type { SessionSkillCatalogEntry } from '@hybridclaw/shared/skill-catalog';
import type {
  StakesScore as CanonicalStakesScore,
  StakesSignal as CanonicalStakesSignal,
} from '@hybridclaw/shared/stakes-classifier';
import type {
  ModelCallTiming,
  TokenUsageStats,
} from '@hybridclaw/shared/token-usage';
import type { ToolCallLimits } from '@hybridclaw/shared/tool-call-limits';
import type { FileBackedToolResults } from '@hybridclaw/shared/tool-history';
import type { RecoveryDisposition } from '@hybridclaw/shared/turn-checkpoint';
import type {
  PdfFilePart,
  VisualAttachmentMessage,
} from '@hybridclaw/shared/visual-snapshots';
import type { WebSearchConfig } from '@hybridclaw/shared/web-search-config';
import type { McpServerConfig } from './mcp/types.js';
import type { ModelBehavior } from './model-behavior.js';

export type {
  ModelCallPerformanceSample,
  ModelCallTiming,
  TokenUsageStats,
} from '@hybridclaw/shared/token-usage';

export interface ChatContentTextPart {
  type: 'text';
  text: string;
}

export interface ChatContentImageUrlPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export interface ChatContentAudioUrlPart {
  type: 'audio_url';
  audio_url: {
    url: string;
  };
}

export type ChatContentPart =
  | ChatContentTextPart
  | ChatContentImageUrlPart
  | ChatContentAudioUrlPart
  | PdfFilePart;
export type ChatMessageContent = string | ChatContentPart[] | null;

export interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface ChatMessage extends VisualAttachmentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatMessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  is_error?: boolean;
  anthropic_content?: AnthropicContentBlock[];
  openai_response_items?: Array<Record<string, unknown>>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: ChatMessageContent;
      tool_calls?: ToolCall[];
      reasoning_content?: string | null;
      anthropic_content?: AnthropicContentBlock[];
      openai_response_items?: Array<Record<string, unknown>>;
    };
    finish_reason: string;
  }>;
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cache_write_input_tokens?: number;
    cached_tokens?: number;
    cache_read?: number;
    cache_write?: number;
    cacheRead?: number;
    cacheWrite?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    input_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
  timing?: ModelCallTiming;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolSchema;
  };
}

export interface ToolRunResult extends VisualAttachmentMessage {
  output: string;
  isError: boolean;
  /** The platform asks the user first; `output` is then only a placeholder. */
  boostOffer?: BoostOffer;
  connectorApproval?: ConnectorApproval;
}

export interface ToolSchema {
  type: 'object';
  properties: Record<string, ToolSchemaProperty>;
  required: string[];
}

export interface ToolSchemaProperty {
  type: string | string[];
  description?: string;
  items?: ToolSchemaProperty;
  properties?: Record<string, ToolSchemaProperty>;
  additionalProperties?: boolean | ToolSchemaProperty;
  required?: string[];
  enum?: string[];
  minItems?: number;
  maxItems?: number;
}

export interface PluginRuntimeToolDefinition {
  name: string;
  description: string;
  parameters: ToolSchema;
}

export interface TaskModelPolicy {
  provider?: RuntimeProviderId;
  providerMethod?: string;
  baseUrl?: string;
  apiKey?: string;
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  modelBehavior?: ModelBehavior;
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
  'eval_judge',
  'mcp',
  'flush_memories',
] as const;

export type TaskModelKey = (typeof TASK_MODEL_KEYS)[number];

export type TaskModelPolicies = {
  [K in TaskModelKey]?: TaskModelPolicy;
};

export interface ContextGuardConfig {
  enabled: boolean;
  compactionRatio: number;
  overflowRatio: number;
  maxRetries: number;
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
  /** Names this request's reply file; see packages/shared/src/ipc-output-files.js. */
  requestId?: string;
  agentId?: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  apiKey: string;
  /**
   * Per-worker secret that authenticates later IPC inputs. Delivered only in
   * the first stdin payload and never written to a file (see
   * packages/shared/src/ipc-input-auth.js).
   */
  ipcAuthSecret?: string;
  baseUrl: string;
  provider?: RuntimeProviderId;
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

export type ToolExecutionStakesSignal = CanonicalStakesSignal;
export type ToolExecutionStakesScore = CanonicalStakesScore;

export interface ToolExecutionAnomalyScore {
  score: number;
  threshold: number | null;
  reason: string;
  status: 'scored' | 'abstained' | 'borderline';
  model: string;
  trajectoryCount: number;
  tuple: string;
  traceJudge?: {
    verdict: 'normal' | 'anomalous' | 'inconclusive' | 'error';
    score: number | null;
    reason: string;
  };
}

export interface EscalationTarget {
  channel: string;
  recipient: string;
}

export function normalizeEscalationTarget(
  value: unknown,
): EscalationTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as { channel?: unknown; recipient?: unknown };
  const channel = typeof raw.channel === 'string' ? raw.channel.trim() : '';
  const recipient =
    typeof raw.recipient === 'string' ? raw.recipient.trim() : '';
  return channel && recipient ? { channel, recipient } : undefined;
}

export interface ToolExecution {
  approvalObservation?: ApprovalObservation;
  name: string;
  arguments: string;
  result: string;
  toolCallId?: string;
  durationMs: number;
  isError?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  approvalTier?: 'green' | 'yellow' | 'red';
  approvalBaseTier?: 'green' | 'yellow' | 'red';
  /** The approval policy's call: this changes or sends something. */
  writeIntent?: boolean;
  autonomyLevel?: 'full-autonomous' | 'low-stakes-autonomous' | 'confirm-each';
  stakes?: 'low' | 'medium' | 'high';
  stakesScore?: ToolExecutionStakesScore;
  anomaly?: ToolExecutionAnomalyScore;
  escalationRoute?:
    | 'none'
    | 'implicit_notice'
    | 'approval_request'
    | 'policy_denial';
  escalationTarget?: EscalationTarget;
  approvalDecision?:
    | 'auto'
    | 'implicit'
    | 'approved_once'
    | 'approved_session'
    | 'approved_agent'
    | 'approved_all'
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
  approvalAllowAll?: boolean;
}

export interface PendingApproval {
  approvalId: string;
  prompt: string;
  intent: string;
  reason: string;
  approvalTier?: 'green' | 'yellow' | 'red';
  toolName?: string;
  commandPreview?: string;
  /** Complete allowlisted review facts; never credentials or attachment bytes. */
  reviewArguments?: string;
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
  expiresAt: number | null;
  /**
   * The rule that paused the call and the kind of action an "always allow"
   * (`yes for agent`) would cover from now on.
   */
  rule?: ApprovalRule;
  escalationTarget?: EscalationTarget;
  /** Set when the question is whether to spend one of the user's boosts. */
  boost?: BoostPrompt;
}

export interface ArtifactMetadata {
  path: string;
  filename: string;
  mimeType: string;
}

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

export interface ContainerOutput
  extends FileWriteGuardContext,
    FileWriteGuardReceipt,
    FileBackedToolResults {
  recovery?: RecoveryDisposition;
  approvalReply?: ApprovalReplyInterpretation;
  status: 'success' | 'error';
  result: string | null;
  toolsUsed: string[];
  outputPresentation?: OutputPresentationMetadata;
  artifacts?: ArtifactMetadata[];
  toolExecutions?: ToolExecution[];
  toolHistory?: ChatMessage[];
  toolHistoryForReplay?: ChatMessage[];
  /** Steering notes the model was shown during the turn, in order. */
  steerNoteIds?: string[];
  pendingApproval?: PendingApproval;
  tokenUsage?: TokenUsageStats;
  error?: string;
  effectiveUserPrompt?: string;
  sideEffects?: {
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
