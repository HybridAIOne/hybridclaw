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
  metadata?: Record<string, unknown>;
}

export interface MiddlewareRunnerOutcome<TContext> {
  context: TContext;
  decision: MiddlewareDecision;
  events: MiddlewareRunnerEvent[];
}

export interface MiddlewareRunnerOptions {
  warn?: (meta: Record<string, unknown>, message: string) => void;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(value)) return undefined;
  return value;
}

function warn(
  options: MiddlewareRunnerOptions | undefined,
  meta: Record<string, unknown>,
  message: string,
): void {
  if (typeof options?.warn === 'function') {
    options.warn(meta, message);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'then' in value &&
      typeof value.then === 'function',
  );
}

export function normalizeMiddlewareDecision(
  value: unknown,
  options: MiddlewareRunnerOptions & {
    skillId?: string;
    phase?: MiddlewarePhase;
  } = {},
): MiddlewareDecision | null {
  if (!value) return null;
  if (!isObjectRecord(value)) {
    warn(
      options,
      { skillId: options.skillId, phase: options.phase },
      'Middleware returned invalid decision shape; treating as allow',
    );
    return null;
  }

  switch (value.action) {
    case 'allow':
      return {
        action: 'allow',
        ...(safeMetadata(value.metadata)
          ? { metadata: safeMetadata(value.metadata) }
          : {}),
      };
    case 'block': {
      const reason = safeText(value.reason);
      return reason
        ? {
            action: 'block',
            reason,
            ...(safeMetadata(value.metadata)
              ? { metadata: safeMetadata(value.metadata) }
              : {}),
          }
        : null;
    }
    case 'warn': {
      const reason = safeText(value.reason);
      return reason
        ? {
            action: 'warn',
            reason,
            ...(safeMetadata(value.metadata)
              ? { metadata: safeMetadata(value.metadata) }
              : {}),
          }
        : null;
    }
    case 'transform': {
      const payload = safeText(value.payload);
      const reason = safeText(value.reason);
      return reason
        ? {
            action: 'transform',
            payload,
            reason,
            ...(safeMetadata(value.metadata)
              ? { metadata: safeMetadata(value.metadata) }
              : {}),
          }
        : null;
    }
    case 'escalate': {
      const reason = safeText(value.reason);
      if (
        reason &&
        (value.route === 'operator' ||
          value.route === 'security' ||
          value.route === 'approval_request' ||
          value.route === 'policy_denial')
      ) {
        return {
          action: 'escalate',
          route: value.route,
          reason,
          ...(safeMetadata(value.metadata)
            ? { metadata: safeMetadata(value.metadata) }
            : {}),
        };
      }
      break;
    }
  }

  warn(
    options,
    { skillId: options.skillId, phase: options.phase, action: value.action },
    'Middleware returned incomplete or unknown decision; treating as allow',
  );
  return null;
}

export async function shouldRunClassifierMiddleware<TContext>(
  skill: ClassifierMiddlewareSkill<TContext>,
  context: TContext,
  phase: MiddlewarePhase,
  options: MiddlewareRunnerOptions = {},
): Promise<boolean> {
  if (!skill.predicate) return true;
  try {
    return Boolean(await skill.predicate(context));
  } catch (error) {
    warn(
      options,
      { skillId: skill.id, phase, error },
      'Middleware predicate failed; skipping middleware',
    );
    return false;
  }
}

export function shouldRunClassifierMiddlewareSync<TContext>(
  skill: ClassifierMiddlewareSkill<TContext>,
  context: TContext,
  phase: MiddlewarePhase,
  options: MiddlewareRunnerOptions = {},
): boolean {
  if (!skill.predicate) return true;
  try {
    const result = skill.predicate(context);
    if (isPromiseLike(result)) {
      throw new Error('Middleware predicate must be synchronous.');
    }
    return Boolean(result);
  } catch (error) {
    warn(
      options,
      { skillId: skill.id, phase, error },
      'Middleware predicate failed; skipping middleware',
    );
    return false;
  }
}

export function applyClassifierMiddlewareSync<TContext>(
  phase: MiddlewarePhase,
  skills: readonly ClassifierMiddlewareSkill<TContext>[],
  context: TContext,
  options: MiddlewareRunnerOptions = {},
): MiddlewareRunnerOutcome<TContext> {
  const events: MiddlewareRunnerEvent[] = [];

  for (const skill of skills) {
    const handler = skill[phase];
    if (!handler) continue;
    if (!shouldRunClassifierMiddlewareSync(skill, context, phase, options)) {
      continue;
    }

    const rawDecision = handler(context);
    if (isPromiseLike(rawDecision)) {
      throw new Error('Middleware handler must be synchronous.');
    }
    const decision = normalizeMiddlewareDecision(rawDecision, {
      ...options,
      skillId: skill.id,
      phase,
    });
    if (!decision || decision.action === 'allow') {
      events.push({
        skillId: skill.id,
        phase,
        action: 'allow',
        metadata: decision?.metadata,
      });
      continue;
    }
    events.push({
      skillId: skill.id,
      phase,
      action: decision.action,
      reason: 'reason' in decision ? decision.reason : undefined,
      metadata: decision.metadata,
    });
    return { context, decision, events };
  }

  return {
    context,
    decision: { action: 'allow' },
    events,
  };
}
