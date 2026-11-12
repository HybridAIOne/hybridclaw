/**
 * Worker protocol data shares usage snapshots with gateway recovery.
 * Provider parsing belongs to token-usage.ts; these types grant no tool
 * authority and do not define a second accounting schema. Saved-result
 * identity is shared with gateway evidence and stays out of provider calls.
 */

import type {
  AnthropicContentBlock,
  ChatMessageContent,
  EscalationTarget,
  TaskModelKey,
  ToolCall,
  ToolSchema,
} from '@hybridclaw/contracts/agent-io';
import type { ModelCallTiming } from '@hybridclaw/contracts/token-usage';
import type { VisualAttachmentMessage } from '@hybridclaw/contracts/visual-snapshots';
import type { BoostOffer } from '@hybridclaw/shared/boost-offer';
import type { ConnectorApproval } from '@hybridclaw/shared/connector-approval';

export type {
  AddressEnvelope,
  AnthropicContentBlock,
  ArtifactMetadata,
  ChatContentAudioUrlPart,
  ChatContentImageUrlPart,
  ChatContentPart,
  ChatContentTextPart,
  ChatMessage,
  ChatMessageContent,
  ContainerInput,
  ContainerOutput,
  ContextGuardConfig,
  DelegationSideEffect,
  DelegationTaskSpec,
  EscalationTarget,
  MediaContextItem,
  OutputDisplaySurface,
  OutputPresentationMetadata,
  OutputSegmentKind,
  PendingApproval,
  PluginRuntimeToolDefinition,
  TaskModelKey,
  TaskModelPolicies,
  TaskModelPolicy,
  ToolCall,
  ToolExecution,
  ToolExecutionAnomalyScore,
  ToolExecutionStakesScore,
  ToolExecutionStakesSignal,
  ToolSchema,
  ToolSchemaProperty,
} from '@hybridclaw/contracts/agent-io';
export type {
  ModelCallPerformanceSample,
  ModelCallTiming,
  TokenUsageStats,
} from '@hybridclaw/contracts/token-usage';

/** Task models the agent runs itself; the gateway runs the other task keys. */
export const AGENT_TASK_MODEL_KEYS = [
  'vision',
  'compression',
  'web_extract',
  'session_search',
  'skills_hub',
  'eval_judge',
  'mcp',
  'flush_memories',
] as const satisfies readonly TaskModelKey[];

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

export type { SessionSkillCatalogEntry } from '@hybridclaw/contracts/skill-catalog';
export type { WebSearchConfig } from '@hybridclaw/contracts/web-search-config';

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
