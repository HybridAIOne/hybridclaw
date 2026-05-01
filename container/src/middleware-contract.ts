export type MiddlewarePhase = 'pre_send' | 'post_receive';

export type EscalationRoute =
  | 'operator'
  | 'security'
  | 'approval_request'
  | 'policy_denial';

export type MiddlewareDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string; payload?: string }
  | { action: 'warn'; reason: string }
  | { action: 'transform'; payload: string; reason: string }
  | { action: 'escalate'; route: EscalationRoute; reason: string };

export interface ClassifierMiddlewareSkill<TContext> {
  id: string;
  priority?: number;
  pre_send?: (context: TContext) => MiddlewareDecision;
  post_receive?: (context: TContext) => MiddlewareDecision;
}
