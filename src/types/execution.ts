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
  durationMs: number;
  isError?: boolean | undefined;
  blocked?: boolean | undefined;
  blockedReason?: string | undefined;
  approvalTier?: 'green' | 'yellow' | 'red' | undefined;
  approvalBaseTier?: 'green' | 'yellow' | 'red' | undefined;
  autonomyLevel?:
    | 'full-autonomous'
    | 'low-stakes-autonomous'
    | 'confirm-each'
    | undefined;
  stakes?: 'low' | 'medium' | 'high' | undefined;
  stakesScore?: ToolExecutionStakesScore | undefined;
  anomaly?: ToolExecutionAnomalyScore | undefined;
  escalationRoute?:
    | 'none'
    | 'implicit_notice'
    | 'approval_request'
    | 'policy_denial'
    | undefined;
  escalationTarget?: EscalationTarget | undefined;
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
    | 'denied'
    | undefined;
  approvalActionKey?: string | undefined;
  approvalIntent?: string | undefined;
  approvalReason?: string | undefined;
  approvalRequestId?: string | undefined;
  approvalExpiresAt?: number | undefined;
  approvalAllowSession?: boolean | undefined;
  approvalAllowAgent?: boolean | undefined;
  approvalAllowAll?: boolean | undefined;
}

export interface PendingApproval {
  approvalId: string;
  prompt: string;
  intent: string;
  reason: string;
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
  expiresAt: number | null;
  escalationTarget?: EscalationTarget | undefined;
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
