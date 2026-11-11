/**
 * One request's inputs survive media fallback and worker replacement unchanged.
 * Unlike model-provider parameters, this includes gateway execution bounds;
 * it carries context and never grants approval or owns live process handles.
 */
import type { ExecutionDeadline } from '@hybridclaw/contracts/agent-io';
import type { ApprovalPrelude } from './tool-approval.js';
import type {
  ChatMessage,
  ContainerInput,
  EscalationTarget,
  ToolDefinition,
} from './types.js';

export interface ProcessRequestParams extends ExecutionDeadline {
  sessionId: string;
  messages: ChatMessage[];
  apiKey: string;
  baseUrl: string;
  provider: ContainerInput['provider'];
  providerMethod?: string;
  isLocal?: boolean;
  contextWindow?: number;
  modelBehavior?: ContainerInput['modelBehavior'];
  thinkingFormat?: 'qwen';
  reasoningEffort?: ContainerInput['reasoningEffort'];
  model: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders?: Record<string, string>;
  tools: ToolDefinition[];
  localToolMode?: ContainerInput['localToolMode'];
  localStarterTools?: string[];
  localDiscoveryDisabled?: boolean;
  deferredTools?: Set<string>;
  taskModels?: ContainerInput['taskModels'];
  contextGuard?: ContainerInput['contextGuard'];
  channelId: string;
  skipContainerSystemPrompt?: boolean;
  streamTextDeltas?: boolean;
  debugModelResponses?: boolean;
  maxTokens?: number;
  effectiveUserPromptOverride?: string;
  ralphMaxIterationsOverride?: number | null;
  escalationTarget?: EscalationTarget;
  approvedToolCall?: ApprovalPrelude['approvedToolCall'];
}
