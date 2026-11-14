export type MiddlewarePhase = 'routing' | 'pre_send' | 'post_receive';

export type EscalationRoute =
  | 'operator'
  | 'security'
  | 'approval_request'
  | 'policy_denial';

export type MiddlewareDecision =
  | { action: 'allow'; metadata?: Record<string, unknown> }
  | { action: 'block'; reason: string; metadata?: Record<string, unknown> }
  | { action: 'warn'; reason: string; metadata?: Record<string, unknown> }
  | {
      action: 'transform';
      payload: string;
      reason: string;
      metadata?: Record<string, unknown>;
    }
  | {
      action: 'escalate';
      route: EscalationRoute;
      reason: string;
      metadata?: Record<string, unknown>;
    };

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
  routing?: (
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
