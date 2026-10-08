import type { BoostPrompt } from '../../container/shared/boost-offer.js';
import type {
  StakesScore as CanonicalStakesScore,
  StakesSignal as CanonicalStakesSignal,
} from '../../container/shared/stakes-classifier.js';

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

export function escalationTargetEquals(
  a?: EscalationTarget,
  b?: EscalationTarget,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.channel === b.channel && a.recipient === b.recipient;
}

export interface ToolExecution {
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
  escalationTarget?: EscalationTarget;
  /** Set when the question is whether to spend one of the user's boosts. */
  boost?: BoostPrompt;
}

/** Where the agent's browser is after a browser tool ran. */
export interface BrowserFrame {
  /** Origin and path only, never the query. */
  url: string;
  title: string;
  /** Viewport JPEG, served by `/api/artifact`; absent while frames are paused. */
  frame?: string;
  /** Set by `browser_sign_in` when nothing is saved for this host: ask the user. */
  signIn?: { host: string };
}

export interface ToolProgressEvent {
  sessionId: string;
  toolName: string;
  /** The model's id for this call; pairs a finish with its start. */
  toolCallId?: string;
  phase: 'start' | 'finish';
  preview?: string;
  durationMs?: number;
  browser?: BrowserFrame;
}

export interface ArtifactMetadata {
  path: string;
  filename: string;
  mimeType: string;
}
