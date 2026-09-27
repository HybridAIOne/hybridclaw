function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function evaluatePolicyExpression(expression, context, predicates) {
  if (!expression) return true;
  if (Array.isArray(expression)) {
    return expression.every((entry) =>
      evaluatePolicyExpression(entry, context, predicates),
    );
  }
  if (typeof expression !== 'object') return false;

  const record = expression;
  // A predicate node passes every other key to its predicate, even one named
  // like an operator (the skill list predicates take `any`).
  if (Object.hasOwn(record, 'predicate')) {
    const predicateName = String(record.predicate || '').trim();
    if (!predicateName) return false;
    const predicate = Object.hasOwn(predicates, predicateName)
      ? predicates[predicateName]
      : undefined;
    if (!predicate) {
      throw new Error(`Unknown policy predicate: ${predicateName}`);
    }
    return Boolean(predicate(context, record));
  }
  if (Array.isArray(record.all)) {
    return record.all.every((entry) =>
      evaluatePolicyExpression(entry, context, predicates),
    );
  }
  if (Array.isArray(record.any)) {
    return record.any.some((entry) =>
      evaluatePolicyExpression(entry, context, predicates),
    );
  }
  if (record.not) {
    return !evaluatePolicyExpression(record.not, context, predicates);
  }
  return false;
}

export function evaluatePolicyRules(params) {
  const matchedRules = [];
  for (const rule of asArray(params.rules)) {
    if (
      !evaluatePolicyExpression(rule.when, params.context, params.predicates)
    ) {
      continue;
    }
    matchedRules.push(rule);
    if (params.mode !== 'all') {
      return {
        action: rule.action,
        matchedRule: rule,
        matchedRules,
      };
    }
  }

  return {
    action:
      matchedRules.length > 0 ? matchedRules[0].action : params.defaultAction,
    matchedRule: matchedRules[0],
    matchedRules,
  };
}
