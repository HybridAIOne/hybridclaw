/**
 * Policy engine: evaluates rules' `when` predicate trees for every policy
 * consumer (network, skill, browser stealth, secret). A predicate name resolves
 * only to a key of the consumer's own registry; any other name throws.
 * `describePolicyRuleProblem` reports what the evaluator would misread, so a
 * consumer can deny or reject an unreadable user rule. NOT a section parser:
 * each consumer owns its actions and what an unreadable rule means.
 */
const POLICY_RULE_KEYS = ['id', 'description', 'comment', 'when', 'action'];
const POLICY_OPERATORS = ['all', 'any', 'not'];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isMapping(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Names a value in a problem without printing a nested (maybe circular) one.
function describeValue(value) {
  if (Array.isArray(value)) return 'a list';
  return isMapping(value) ? 'a mapping' : JSON.stringify(value);
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

// A text parameter: a non-empty string or a number, or a non-empty list of them.
export function checkPolicyText(value) {
  const entries = Array.isArray(value) ? value : [value];
  const readable =
    entries.length > 0 &&
    entries.every((entry) =>
      typeof entry === 'string' ? entry.trim() !== '' : Number.isFinite(entry),
    );
  return readable ? '' : 'must be a string or a list of strings';
}

function describePredicateProblem(node, predicates, path) {
  const name = typeof node.predicate === 'string' ? node.predicate.trim() : '';
  if (!Object.hasOwn(predicates, name)) {
    return `${path} predicate ${describeValue(node.predicate)} is unknown (known: ${Object.keys(predicates).join(', ')})`;
  }
  const parameters = predicates[name];
  const groups = new Map();
  for (const key of Object.keys(node)) {
    if (key === 'predicate') continue;
    if (!Object.hasOwn(parameters, key)) {
      return `${path} has unknown ${name} parameter "${key}" (allowed: ${Object.keys(parameters).join(', ')})`;
    }
    const group = parameters[key].group ?? key;
    if (groups.has(group)) {
      return `${path} sets both ${groups.get(group)} and ${key}`;
    }
    groups.set(group, key);
    const problem = parameters[key].check(node[key]);
    if (problem) return `${path}.${key} ${problem}`;
  }
  // A predicate with required parameters needs at least one of them.
  const required = Object.keys(parameters).filter(
    (key) => parameters[key].required,
  );
  if (
    required.length === 0 ||
    required.some((key) => Object.hasOwn(node, key))
  ) {
    return '';
  }
  return required.length === 1
    ? `${path} needs ${name} parameter ${required[0]}`
    : `${path} needs one of the ${name} parameters ${required.join(', ')}`;
}

// `ancestors` holds the nodes above this one: YAML aliases can make a `when`
// contain itself, while two branches may share one aliased node.
function describeExpressionProblem(expression, predicates, path, ancestors) {
  if (ancestors.includes(expression)) return `${path} refers to itself`;
  if (Array.isArray(expression)) {
    if (expression.length === 0) return `${path} is an empty list`;
    for (const [index, entry] of expression.entries()) {
      const problem = describeExpressionProblem(
        entry,
        predicates,
        `${path}[${index}]`,
        [...ancestors, expression],
      );
      if (problem) return problem;
    }
    return '';
  }
  if (!isMapping(expression)) {
    return `${path} is ${describeValue(expression)}, not a mapping or a list`;
  }
  if (Object.hasOwn(expression, 'predicate')) {
    return describePredicateProblem(expression, predicates, path);
  }
  const keys = Object.keys(expression);
  const operator = keys[0];
  if (keys.length !== 1 || !POLICY_OPERATORS.includes(operator)) {
    const got = keys.map((key) => `"${key}"`).join(', ') || 'no keys';
    return `${path} must set exactly one of predicate, all, any, not (got ${got})`;
  }
  if (operator !== 'not' && !Array.isArray(expression[operator])) {
    return `${path}.${operator} is ${describeValue(expression[operator])}, not a list`;
  }
  return describeExpressionProblem(
    expression[operator],
    predicates,
    `${path}.${operator}`,
    [...ancestors, expression],
  );
}

// Returns a clause without a subject for the rule itself ("has unknown key
// ...") and one that starts with its path for the `when` tree ("when.all[1]
// ..."), so a consumer can prefix its own rule label.
export function describePolicyRuleProblem(rule, predicates) {
  if (!isMapping(rule)) return `is ${describeValue(rule)}, not a mapping`;
  const unknownKey = Object.keys(rule).find(
    (key) => !POLICY_RULE_KEYS.includes(key) && !key.startsWith('managed_by_'),
  );
  if (unknownKey !== undefined) {
    return `has unknown key "${unknownKey}" (allowed: ${POLICY_RULE_KEYS.join(', ')}, managed_by_*)`;
  }
  if (rule.when === undefined) return '';
  return describeExpressionProblem(rule.when, predicates, 'when', []);
}
