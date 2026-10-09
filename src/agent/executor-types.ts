import type { ApprovalMode } from '../../container/shared/approval-mode.js';
import type { ReasoningEffort } from '../../container/shared/reasoning-effort.js';
import type { SessionAttachmentAccess } from '../../container/shared/session-attachment-access.js';
import type { RuntimeBrowserProviderKind } from '../config/runtime-config.js';
import type { SteerInbox } from '../infra/steer-inbox.js';
import type { ChatMessage } from '../types/api.js';
import type {
  AddressEnvelope,
  ContainerOutput,
  MediaContextItem,
  SessionSkillCatalogEntry,
} from '../types/container.js';
import type {
  EscalationTarget,
  PendingApproval,
  PluginRuntimeToolDefinition,
  ToolProgressEvent,
} from '../types/execution.js';
import type { PromptClient } from './prompt-hooks.js';

export interface ExecutorRequest extends SessionAttachmentAccess {
  sessionId: string;
  runId?: string;
  messages: ChatMessage[];
  chatbotId: string;
  enableRag: boolean;
  executorModeOverride?: 'host' | 'container';
  model?: string;
  reasoningEffort?: ReasoningEffort;
  agentId?: string;
  addressEnvelope?: AddressEnvelope;
  workspacePathOverride?: string;
  workspaceDisplayRootOverride?: string;
  /**
   * A scoped chat's run: its worker gets the scope's runtime token, so its
   * gateway callbacks act only on that scope's chats.
   */
  runtimeScope?: { agentId: string; scopeId: string };
  skipContainerSystemPrompt?: boolean;
  maxTokens?: number;
  maxWallClockMs?: number | null;
  inactivityTimeoutMs?: number | null;
  bashProxy?:
    | {
        mode: 'docker-exec';
        containerName: string;
        cwd?: string;
      }
    | undefined;
  channelId?: string;
  /** The app that sent the turn, for request correlation. */
  client?: PromptClient;
  /** The browser this run drives; the configured provider when unset. */
  browserProvider?: RuntimeBrowserProviderKind;
  ralphMaxIterations?: number | null;
  approvalMode?: ApprovalMode;
  fullAutoNeverApproveTools?: string[];
  scheduleSideEffectsEnabled?: boolean;
  /**
   * No one waits on this run (scheduled task, heartbeat, goal loop). It
   * leaves one agent process free for user turns and waits longer for one.
   */
  background?: boolean;
  skillCatalog?: SessionSkillCatalogEntry[];
  allowedTools?: string[];
  blockedTools?: string[];
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  onApprovalProgress?: (approval: PendingApproval) => void;
  abortSignal?: AbortSignal;
  media?: MediaContextItem[];
  audioTranscriptsPrepended?: boolean;
  pluginTools?: PluginRuntimeToolDefinition[];
  escalationTarget?: EscalationTarget;
  /** Notes the user sends while this request runs; see infra/steer-inbox.ts. */
  steerInbox?: SteerInbox;
}

export interface Executor {
  exec(request: ExecutorRequest): Promise<ContainerOutput>;
  getWorkspacePath(agentId: string): string;
  stopSession(sessionId: string): boolean;
  stopAll(): void;
  getActiveSessionCount(): number;
  getInFlightSessionCount(): number;
  getActiveSessionIds(): string[];
  getInFlightSessionIds(): string[];
  getSessionHealthSnapshots(): Promise<ExecutorSessionHealthSnapshot[]>;
}

export interface ExecutorSessionHealthSnapshot {
  mode: 'container' | 'host';
  sessionId: string;
  agentId: string;
  responsive: boolean;
  startedAt: number;
  lastUsedAt: number;
  readyForInputAt: number | null;
  busy: boolean;
  terminalError: string | null;
  healthError: string | null;
}
