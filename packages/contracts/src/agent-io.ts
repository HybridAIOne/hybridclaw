/**
 * Gateway ↔ agent contract: the one definition of what the gateway sends a
 * worker (`ContainerInput`) and what a worker replies (`ContainerOutput`).
 *
 * The reply is untrusted, so it is a schema: the gateway checks every reply
 * against `ContainerOutputSchema` (plus the shared tool-history and token-usage
 * validators) before anything reads it. The input is written by the gateway
 * itself and stays a plain type until something needs to check it. NOT the
 * file transport (`ipc.ts`) or the console API.
 */
import type {
  ApprovalMode,
  ApprovalObservation,
} from '@hybridclaw/shared/approval-mode';
import type { ApprovalReplyContext } from '@hybridclaw/shared/approval-reply';
import type { ApprovalRule } from '@hybridclaw/shared/approval-rules';
import type { BoostPrompt } from '@hybridclaw/shared/boost-offer';
import type { McpServerConfig } from '@hybridclaw/shared/mcp-server-config';
import type { RuntimeProviderId } from '@hybridclaw/shared/provider-ids';
import type { ReasoningEffort } from '@hybridclaw/shared/reasoning-effort';
import type { SessionAttachmentAccess } from '@hybridclaw/shared/session-attachment-access';
import type { SessionSkillCatalogEntry } from '@hybridclaw/shared/skill-catalog';
import type {
  StakesScore,
  StakesSignal,
} from '@hybridclaw/shared/stakes-classifier';
import type { TokenUsageStats } from '@hybridclaw/shared/token-usage';
import type { ToolCallLimits } from '@hybridclaw/shared/tool-call-limits';
import type { FileBackedToolResult } from '@hybridclaw/shared/tool-history';
import type {
  PdfFilePart,
  VisualAttachmentMessage,
} from '@hybridclaw/shared/visual-snapshots';
import type { WebSearchConfig } from '@hybridclaw/shared/web-search-config';
import {
  array,
  boolean,
  type Infer,
  type InferObject,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  unchecked,
  union,
} from './schema.ts';

// ── Model messages ──────────────────────────────────────────────────────────

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

/** Model messages keep tool ids and opaque provider replay metadata. */
export interface ChatMessage
  extends VisualAttachmentMessage,
    FileBackedToolResult {
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

// ── Gateway → agent ─────────────────────────────────────────────────────────

export type ModelThinkingFormat = 'qwen';

export interface ModelBehavior {
  thinkingFormat?: ModelThinkingFormat;
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

export const TASK_MODEL_KEYS = [
  'vision',
  'compression',
  'web_extract',
  'session_search',
  'skills_hub',
  'eval_judge',
  'goal_judge',
  'mcp',
  'flush_memories',
  'btw',
  'second_opinion',
  'session_title',
] as const;

export type TaskModelKey = (typeof TASK_MODEL_KEYS)[number];

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

export type TaskModelPolicies = {
  [K in TaskModelKey]?: TaskModelPolicy;
};

export interface ContextGuardConfig {
  enabled: boolean;
  compactionRatio: number;
  overflowRatio: number;
  maxRetries: number;
}

export interface AddressEnvelope {
  to: string | string[];
  from?: string | null;
  fanoutAlias?: 'team' | 'all';
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
  /** Only reads run; every other tool call returns its refusal to the model. */
  dryRun?: boolean;
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

// ── Agent → gateway ─────────────────────────────────────────────────────────

const approvalTier = () => literal('green', 'yellow', 'red');

export const FileWriteGuardContextShape = {
  /** Root worker session whose write conflicts this delegated worker shares. */
  fileWriteGuardSessionId: optional(string()),
  /** Gateway-owned root request; a model-authored delegation cannot replace it. */
  fileWriteGuardUserPrompt: optional(string()),
};
/** Gateway-owned delegation lineage for conflict state, never an approval grant. */
export type FileWriteGuardContext = InferObject<
  typeof FileWriteGuardContextShape
>;

export const FileWriteGuardReceiptShape = {
  fileWriteGuardProof: optional(string()),
};
/** Controller-authenticated request context; never supplied by model tool args. */
export type FileWriteGuardReceipt = InferObject<
  typeof FileWriteGuardReceiptShape
>;

export const EscalationTargetSchema = object({
  channel: string(),
  recipient: string(),
});
export type EscalationTarget = Infer<typeof EscalationTargetSchema>;

export type ToolExecutionStakesSignal = StakesSignal;
export type ToolExecutionStakesScore = StakesScore;

export const ToolExecutionAnomalyScoreSchema = object({
  score: number(),
  threshold: nullable(number()),
  reason: string(),
  status: literal('scored', 'abstained', 'borderline'),
  model: string(),
  trajectoryCount: number(),
  tuple: string(),
  traceJudge: optional(
    object({
      verdict: literal('normal', 'anomalous', 'inconclusive', 'error'),
      score: nullable(number()),
      reason: string(),
    }),
  ),
});
export type ToolExecutionAnomalyScore = Infer<
  typeof ToolExecutionAnomalyScoreSchema
>;

export const ToolExecutionSchema = object({
  approvalObservation: optional(unchecked<ApprovalObservation>()),
  name: string(),
  arguments: string(),
  result: string(),
  toolCallId: optional(string()),
  /** Identifies the saved result's bytes; the gateway checks its format. */
  resultDigest: optional(string()),
  durationMs: number(),
  isError: optional(boolean()),
  blocked: optional(boolean()),
  blockedReason: optional(string()),
  approvalTier: optional(approvalTier()),
  approvalBaseTier: optional(approvalTier()),
  /** The approval policy's call: this changes or sends something. */
  writeIntent: optional(boolean()),
  autonomyLevel: optional(
    literal('full-autonomous', 'low-stakes-autonomous', 'confirm-each'),
  ),
  stakes: optional(literal('low', 'medium', 'high')),
  stakesScore: optional(unchecked<ToolExecutionStakesScore>()),
  anomaly: optional(ToolExecutionAnomalyScoreSchema),
  escalationRoute: optional(
    literal('none', 'implicit_notice', 'approval_request', 'policy_denial'),
  ),
  escalationTarget: optional(EscalationTargetSchema),
  approvalDecision: optional(
    literal(
      'auto',
      'implicit',
      'approved_once',
      'approved_session',
      'approved_agent',
      'approved_all',
      'approved_fullauto',
      'promoted',
      'required',
      'denied',
    ),
  ),
  approvalActionKey: optional(string()),
  approvalIntent: optional(string()),
  approvalReason: optional(string()),
  approvalRequestId: optional(string()),
  approvalExpiresAt: optional(number()),
  approvalAllowSession: optional(boolean()),
  approvalAllowAgent: optional(boolean()),
  approvalAllowAll: optional(boolean()),
});
export type ToolExecution = Infer<typeof ToolExecutionSchema>;

export const PendingApprovalSchema = object({
  approvalId: string(),
  prompt: string(),
  intent: string(),
  reason: string(),
  approvalTier: optional(approvalTier()),
  toolName: optional(string()),
  commandPreview: optional(string()),
  /** Complete allowlisted review facts; never credentials or attachment bytes. */
  reviewArguments: optional(string()),
  allowSession: boolean(),
  allowAgent: boolean(),
  allowAll: boolean(),
  expiresAt: nullable(number()),
  /**
   * The rule that paused the call and the kind of action an "always allow"
   * (`yes for agent`) would cover from now on.
   */
  rule: optional(unchecked<ApprovalRule>()),
  escalationTarget: optional(EscalationTargetSchema),
  /** Set when the question is whether to spend one of the user's boosts. */
  boost: optional(unchecked<BoostPrompt>()),
});
export type PendingApproval = Infer<typeof PendingApprovalSchema>;

export const ArtifactMetadataSchema = object({
  path: string(),
  filename: string(),
  mimeType: string(),
});
export type ArtifactMetadata = Infer<typeof ArtifactMetadataSchema>;

export const OutputSegmentKindSchema = literal(
  'draft',
  'final',
  'tool_request',
  'approval',
  'status',
);
export type OutputSegmentKind = Infer<typeof OutputSegmentKindSchema>;

export const OutputDisplaySurfaceSchema = literal(
  'none',
  'assistant_bubble',
  'approval',
);
export type OutputDisplaySurface = Infer<typeof OutputDisplaySurfaceSchema>;

export const OutputPresentationMetadataSchema = object({
  segmentKind: OutputSegmentKindSchema,
  visible: boolean(),
  displaySurface: OutputDisplaySurfaceSchema,
});
export type OutputPresentationMetadata = Infer<
  typeof OutputPresentationMetadataSchema
>;

export const MemoryCitationSchema = object({
  /** Stable reference tag used in the prompt, e.g. "[mem:3]" */
  ref: string(),
  /** semantic_memories.id */
  memoryId: number(),
  /** Truncated content preview */
  content: string(),
  /** Decayed confidence at recall time */
  confidence: number(),
});
export type MemoryCitation = Infer<typeof MemoryCitationSchema>;

export const DelegationTaskSpecSchema = object({
  prompt: string(),
  label: optional(string()),
  model: optional(string()),
});
export type DelegationTaskSpec = Infer<typeof DelegationTaskSpecSchema>;

export const DelegationSideEffectSchema = object({
  action: literal('delegate'),
  mode: optional(literal('single', 'parallel', 'chain')),
  prompt: optional(string()),
  label: optional(string()),
  model: optional(string()),
  tasks: optional(array(DelegationTaskSpecSchema)),
  chain: optional(array(DelegationTaskSpecSchema)),
});
export type DelegationSideEffect = Infer<typeof DelegationSideEffectSchema>;

export const ApprovalReplyInterpretationSchema = object({
  decision: literal(
    'approve',
    'deny',
    'revise',
    'unclear',
    'unrelated',
    'error',
  ),
  approvalId: nullable(string()),
  scope: nullable(literal('once', 'session', 'agent', 'all')),
  model: optional(string()),
});
/** An interpretation is not proof of execution; tool audit events record that. */
export type ApprovalReplyInterpretation = Infer<
  typeof ApprovalReplyInterpretationSchema
>;

export const RecoveryDispositionSchema = union(
  object({ kind: literal('refused'), turnId: optional(string()) }),
  object({
    kind: literal('recovered'),
    turnId: string(),
    calls: array(
      object({
        messageIndex: number(),
        toolCallId: string(),
        outcome: literal('result_recorded', 'outcome_unknown', 'not_executed'),
      }),
    ),
  }),
);
export type RecoveryDisposition = Infer<typeof RecoveryDispositionSchema>;

/** `busy`: every agent process was taken, so the turn never started. */
export const AgentErrorCodeSchema = literal('busy');
export type AgentErrorCode = Infer<typeof AgentErrorCodeSchema>;

/**
 * Tool history and token usage carry their own validators in
 * @hybridclaw/shared (they need Node); the gateway applies them on top.
 */
export const ContainerOutputSchema = object({
  ...FileWriteGuardContextShape,
  ...FileWriteGuardReceiptShape,
  recovery: optional(RecoveryDispositionSchema),
  approvalReply: optional(ApprovalReplyInterpretationSchema),
  status: literal('success', 'error'),
  result: nullable(string()),
  toolsUsed: array(string()),
  outputPresentation: optional(OutputPresentationMetadataSchema),
  artifacts: optional(array(ArtifactMetadataSchema)),
  memoryCitations: optional(array(MemoryCitationSchema)),
  toolExecutions: optional(array(ToolExecutionSchema)),
  toolHistory: optional(unchecked<ChatMessage[]>()),
  toolHistoryForReplay: optional(unchecked<ChatMessage[]>()),
  /** Results sent as file references; model input retains the complete text. */
  spilledToolCallIds: optional(array(string())),
  /** Steering notes the model was shown during the turn, in order. */
  steerNoteIds: optional(array(string())),
  pendingApproval: optional(PendingApprovalSchema),
  tokenUsage: optional(unchecked<TokenUsageStats>()),
  error: optional(string()),
  /** What kind of error, for clients that word it themselves. */
  errorCode: optional(AgentErrorCodeSchema),
  effectiveUserPrompt: optional(string()),
  sideEffects: optional(
    object({ delegations: optional(array(DelegationSideEffectSchema)) }),
  ),
});
export type ContainerOutput = Infer<typeof ContainerOutputSchema>;
