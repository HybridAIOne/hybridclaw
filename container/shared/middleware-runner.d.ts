import type {
  ClassifierMiddlewareSkill,
  MiddlewareDecision,
  MiddlewarePhase,
} from './middleware-contract.js';

export interface MiddlewareRunnerEvent {
  skillId: string;
  phase: MiddlewarePhase;
  action: MiddlewareDecision['action'];
  reason?: string;
}

export interface MiddlewareRunnerOutcome<TContext> {
  context: TContext;
  decision: MiddlewareDecision;
  events: MiddlewareRunnerEvent[];
}

export interface MiddlewareRunnerOptions {
  warn?: (meta: Record<string, unknown>, message: string) => void;
}

export function normalizeMiddlewareDecision(
  value: unknown,
  options?: MiddlewareRunnerOptions & {
    skillId?: string;
    phase?: MiddlewarePhase;
  },
): MiddlewareDecision | null;

export function shouldRunClassifierMiddleware<TContext>(
  skill: ClassifierMiddlewareSkill<TContext>,
  context: TContext,
  phase: MiddlewarePhase,
  options?: MiddlewareRunnerOptions,
): Promise<boolean>;

export function shouldRunClassifierMiddlewareSync<TContext>(
  skill: ClassifierMiddlewareSkill<TContext>,
  context: TContext,
  phase: MiddlewarePhase,
  options?: MiddlewareRunnerOptions,
): boolean;

export function applyClassifierMiddlewareSync<TContext>(
  phase: MiddlewarePhase,
  skills: readonly ClassifierMiddlewareSkill<TContext>[],
  context: TContext,
  options?: MiddlewareRunnerOptions,
): MiddlewareRunnerOutcome<TContext>;
