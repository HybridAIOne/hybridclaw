export type MiddlewarePhase = 'pre_send' | 'post_receive';

export type EscalationRoute =
  | 'operator'
  | 'security'
  | 'approval_request'
  | 'policy_denial';

export type MiddlewareDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'warn'; reason: string }
  | { action: 'transform'; payload: string; reason: string }
  | { action: 'escalate'; route: EscalationRoute; reason: string };

export type MiddlewarePredicate<TContext> =
  | ((context: TContext) => Promise<boolean> | boolean)
  | undefined;

export interface ClassifierMiddlewareSkill<TContext = unknown> {
  id: string;
  priority?: number;
  predicate?: MiddlewarePredicate<TContext>;
  pre_send?: (
    context: TContext,
  ) =>
    | Promise<MiddlewareDecision | null | undefined>
    | MiddlewareDecision
    | null
    | undefined;
  post_receive?: (
    context: TContext,
  ) =>
    | Promise<MiddlewareDecision | null | undefined>
    | MiddlewareDecision
    | null
    | undefined;
}
