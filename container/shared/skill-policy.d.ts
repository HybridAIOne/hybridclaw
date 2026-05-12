import type { PolicyPredicateExpression } from './policy-engine.js';

export type SkillPolicyActionType =
  | 'allow'
  | 'deny'
  | 'block'
  | 'warn'
  | 'log'
  | 'confirm-each';

export interface SkillPolicyAction {
  type: SkillPolicyActionType;
  reason?: string;
  [key: string]: unknown;
}

export interface SkillPolicyRule {
  id?: string;
  description?: string;
  when?: PolicyPredicateExpression | PolicyPredicateExpression[];
  action: SkillPolicyAction;
  metadata?: Record<string, unknown>;
}

export interface SkillPolicyState {
  rules: SkillPolicyRule[];
}

export interface SkillPolicyAccessInput {
  rules: SkillPolicyRule[];
  agentId: string;
  skillName: string;
  skillId?: string | undefined;
  source?: string | undefined;
  category?: string | undefined;
  channel?: string | undefined;
  capabilities?: string[] | undefined;
  roles?: string[] | undefined;
  tenantId?: string | undefined;
  qualityScore?: number | undefined;
}

export interface SkillPolicyAccessEvaluation {
  decision: 'allow' | 'deny';
  action: SkillPolicyAction;
  matchedRule?: SkillPolicyRule;
}

export const DEFAULT_SKILL_POLICY_ACTION: SkillPolicyAction;

export function readSkillPolicyState(
  document: Record<string, unknown>,
): SkillPolicyState;

export function evaluateSkillPolicyAccess(
  params: SkillPolicyAccessInput,
): SkillPolicyAccessEvaluation;
