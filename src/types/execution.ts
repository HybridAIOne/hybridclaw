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

export interface ToolExecution {
  name: string;
  arguments: string;
  result: string;
  durationMs: number;
  isError?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  approvalTier?: 'green' | 'yellow' | 'red';
  approvalBaseTier?: 'green' | 'yellow' | 'red';
  autonomyLevel?: 'full-autonomous' | 'low-stakes-autonomous' | 'confirm-each';
  stakes?: 'low' | 'medium' | 'high';
  stakesScore?: ToolExecutionStakesScore;
  escalationRoute?:
    | 'none'
    | 'implicit_notice'
    | 'approval_request'
    | 'policy_denial';
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
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
  expiresAt: number | null;
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
