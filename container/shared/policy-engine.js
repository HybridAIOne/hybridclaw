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

  const predicateName = String(record.predicate || '').trim();
  if (!predicateName) return false;
  const predicate = predicates[predicateName];
  if (!predicate) {
    throw new Error(`Unknown policy predicate: ${predicateName}`);
  }
  return Boolean(predicate(context, record));
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
