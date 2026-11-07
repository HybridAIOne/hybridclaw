/**
 * Browser stealth policy: the `browser.stealth` section of `policy.yaml`,
 * allowlisting Camofox stealth mode per host (default deny). An unreadable rule
 * is enforced as deny and never throws, since the container falls back to its
 * built-in approval policy on a throw: an unknown action keeps the rule's
 * `when`, anything else denies every host. NOT the network reachability policy.
 */
import { matchesNetworkHostPattern } from './network-policy.js';
import type { PolicyParameterSpec, PolicyRule } from './policy-engine.js';
import {
  checkPolicyText,
  describePolicyRuleProblem,
  evaluatePolicyRules,
} from './policy-engine.js';
import { asRecord } from './primitive-values.js';

export type BrowserStealthPolicyDecision = 'allow' | 'deny';

export interface BrowserStealthPolicyContext {
  host: string;
  agentId?: string;
  skillName?: string;
}

export interface BrowserStealthPolicyState {
  rules: PolicyRule<BrowserStealthPolicyDecision>[];
}

export interface BrowserStealthPolicyAccessEvaluation {
  decision: BrowserStealthPolicyDecision;
  matchedRule?: PolicyRule<BrowserStealthPolicyDecision>;
}

interface StealthAllowedParameter extends PolicyParameterSpec {
  match: (context: BrowserStealthPolicyContext, expected: unknown) => boolean;
}

function normalizeString(value: unknown): string {
  return Array.from(String(value ?? '').trim())
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
}

function normalizeLower(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeString).filter(Boolean);
  }
  return [];
}

function normalizeAction(value: unknown): BrowserStealthPolicyDecision | null {
  const normalized = normalizeLower(value);
  if (normalized === 'allow') return 'allow';
  if (normalized === 'deny' || normalized === 'block') return 'deny';
  return null;
}

function normalizeBrowserStealthRule(
  raw: unknown,
  index: number,
): PolicyRule<BrowserStealthPolicyDecision> {
  const record = asRecord(raw) ?? {};
  const id = normalizeString(record.id);
  const problem = describePolicyRuleProblem(raw, BROWSER_STEALTH_PARAMETERS);
  const action = problem ? null : normalizeAction(record.action);
  return {
    ...(id ? { id } : {}),
    // An unreadable rule covers every host; an unknown action keeps `when`.
    when: problem
      ? undefined
      : (record.when as PolicyRule<BrowserStealthPolicyDecision>['when']),
    action: action ?? 'deny',
    ...(action
      ? {}
      : {
          description: `Unreadable browser stealth rule #${index + 1}${problem ? ` ${problem}` : ''}, enforced as deny`,
        }),
  };
}

export function readBrowserStealthPolicyStateFromDocument(
  document: Record<string, unknown>,
): BrowserStealthPolicyState {
  const browser = asRecord(document.browser) ?? {};
  const stealth = asRecord(browser.stealth) ?? {};
  const rules = Array.isArray(stealth.rules)
    ? stealth.rules.map(normalizeBrowserStealthRule)
    : [];
  return { rules };
}

function matchesText(candidate: unknown, expected: unknown): boolean {
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

const STEALTH_ALLOWED_PARAMETERS: Record<string, StealthAllowedParameter> = {
  host: {
    required: true,
    check: (value: unknown) =>
      typeof value === 'string' && value.trim() ? '' : 'must be a host pattern',
    match: (context, host) => matchesNetworkHostPattern(host, context.host),
  },
  skillName: {
    check: checkPolicyText,
    match: (context, expected) =>
      matchesText(context.skillName || '', expected),
  },
  agentId: {
    check: checkPolicyText,
    match: (context, expected) => matchesText(context.agentId || '', expected),
  },
};

// The parser accepts exactly the parameters the evaluator reads.
const BROWSER_STEALTH_PARAMETERS = {
  browser_stealth_allowed: STEALTH_ALLOWED_PARAMETERS,
};

const BROWSER_STEALTH_POLICY_PREDICATES = {
  browser_stealth_allowed: (
    context: BrowserStealthPolicyContext,
    node: Record<string, unknown>,
  ) =>
    Object.entries(STEALTH_ALLOWED_PARAMETERS).every(([key, parameter]) =>
      Object.hasOwn(node, key)
        ? parameter.match(context, node[key])
        : !parameter.required,
    ),
};

export function evaluateBrowserStealthPolicyAccess(params: {
  state: BrowserStealthPolicyState;
  context: BrowserStealthPolicyContext;
}): BrowserStealthPolicyAccessEvaluation {
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
