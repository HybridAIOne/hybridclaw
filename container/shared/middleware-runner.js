function isObjectRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function warn(options, meta, message) {
  if (typeof options?.warn === 'function') {
    options.warn(meta, message);
  }
}

function isPromiseLike(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'then' in value &&
      typeof value.then === 'function',
  );
}

export function normalizeMiddlewareDecision(value, options = {}) {
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
      return { action: 'allow' };
    case 'block': {
      const reason = safeText(value.reason);
      return reason ? { action: 'block', reason } : null;
    }
    case 'warn': {
      const reason = safeText(value.reason);
      return reason ? { action: 'warn', reason } : null;
    }
    case 'transform': {
      const payload = safeText(value.payload);
      const reason = safeText(value.reason);
      return reason ? { action: 'transform', payload, reason } : null;
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
        return { action: 'escalate', route: value.route, reason };
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

export async function shouldRunClassifierMiddleware(
  skill,
  context,
  phase,
  options = {},
) {
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

export function shouldRunClassifierMiddlewareSync(
  skill,
  context,
  phase,
  options = {},
) {
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

export function applyClassifierMiddlewareSync(
  phase,
  skills,
  context,
  options = {},
) {
  const events = [];

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
      events.push({ skillId: skill.id, phase, action: 'allow' });
      continue;
    }
    events.push({
      skillId: skill.id,
      phase,
      action: decision.action,
      reason: 'reason' in decision ? decision.reason : undefined,
    });
    return { context, decision, events };
  }

  return {
    context,
    decision: { action: 'allow' },
    events,
  };
}
