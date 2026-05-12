import { matchesNetworkHostPattern } from './network-policy.js';
import { evaluatePolicyRules } from './policy-engine.js';

export function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeString(value) {
  return Array.from(String(value ?? '').trim())
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeString).filter(Boolean);
  }
  return [];
}

function normalizeAction(value) {
  const normalized = normalizeLower(value);
  if (normalized === 'allow') return 'allow';
  if (normalized === 'deny' || normalized === 'block') return 'deny';
  return null;
}

function normalizeBrowserStealthRule(raw) {
  const record = asRecord(raw);
  const action = normalizeAction(record.action);
  if (!action) return null;
  const id = normalizeString(record.id);
  return {
    ...(id ? { id } : {}),
    when: record.when,
    action,
  };
}

export function readBrowserStealthPolicyStateFromDocument(document) {
  const browser = asRecord(document.browser);
  const stealth = asRecord(browser.stealth);
  const rules = Array.isArray(stealth.rules)
    ? stealth.rules
        .map((rule) => normalizeBrowserStealthRule(rule))
        .filter(Boolean)
    : [];
  return { rules };
}

function matchesText(candidate, expected) {
  const normalized = normalizeLower(candidate);
  const values = normalizeStringList(expected);
  if (values.length === 0) {
    const single = normalizeLower(expected);
    return single === '*' || normalized === single;
  }
  return values.some((entry) => {
    const comparable = normalizeLower(entry);
    return comparable === '*' || comparable === normalized;
  });
}

const BROWSER_STEALTH_POLICY_PREDICATES = {
  browser_stealth_allowed: (context, params) => {
    if (params.host === undefined) return false;
    if (!matchesNetworkHostPattern(params.host, context.host)) return false;
    if (
      params.skillName !== undefined &&
      !matchesText(context.skillName || '', params.skillName)
    ) {
      return false;
    }
    if (
      params.agentId !== undefined &&
      !matchesText(context.agentId || '', params.agentId)
    ) {
      return false;
    }
    return true;
  },
};

export function evaluateBrowserStealthPolicyAccess(params) {
  const evaluation = evaluatePolicyRules({
    rules: params.state.rules,
    context: {
      ...params.context,
      host: normalizeLower(params.context.host),
    },
    predicates: BROWSER_STEALTH_POLICY_PREDICATES,
    defaultAction: 'deny',
  });
  return {
    decision: evaluation.action === 'allow' ? 'allow' : 'deny',
    matchedRule: evaluation.matchedRule,
  };
}
