import fs from 'node:fs';

import YAML from 'yaml';
import { matchesNetworkHostPattern } from '../policy/network-policy.js';
import {
  evaluatePolicyRules,
  type PolicyPredicateExpression,
  type PolicyPredicateRegistry,
  type PolicyRule,
} from '../policy/policy-engine.js';
import { resolveWorkspacePolicyPath } from '../policy/policy-store.js';
import type { SecretSinkKind } from './secret-handles.js';

export type SecretPolicyDecision = 'allow' | 'deny';

export interface SecretPolicyContext {
  agentId?: string;
  skillName?: string;
  secretSource: 'env' | 'store';
  secretId: string;
  sinkKind: SecretSinkKind;
  host?: string;
  selector?: string;
}

export interface SecretPolicyState {
  defaultAction: SecretPolicyDecision;
  rules: PolicyRule<SecretPolicyDecision>[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeLower(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeString).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeAction(value: unknown): SecretPolicyDecision | null {
  const raw = typeof value === 'string' ? value : asRecord(value).type;
  const normalized = normalizeLower(raw);
  if (normalized === 'allow') return 'allow';
  if (normalized === 'deny' || normalized === 'block') return 'deny';
  return null;
}

function normalizeRule(raw: unknown): PolicyRule<SecretPolicyDecision> | null {
  const record = asRecord(raw);
  const action = normalizeAction(record.action);
  if (!action) return null;
  const id = normalizeString(record.id);
  return {
    ...(id ? { id } : {}),
    when: record.when as
      | PolicyPredicateExpression
      | PolicyPredicateExpression[]
      | undefined,
    action,
    metadata: { secretRule: raw },
  };
}

export function readSecretPolicyStateFromDocument(
  document: Record<string, unknown>,
): SecretPolicyState {
  const secret = asRecord(document.secret);
  const rules = Array.isArray(secret.rules)
    ? secret.rules
        .map(normalizeRule)
        .filter((rule): rule is PolicyRule<SecretPolicyDecision> =>
          Boolean(rule),
        )
    : [];
  const defaultAction =
    normalizeLower(secret.default) === 'allow' ? 'allow' : 'deny';
  return { defaultAction, rules };
}

function readPolicyDocument(policyPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse policy file ${policyPath}: ${message}`);
  }
  if (!parsed) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Policy file must contain a YAML mapping: ${policyPath}`);
  }
  return parsed as Record<string, unknown>;
}

export function readWorkspaceSecretPolicyState(
  workspacePath: string,
): SecretPolicyState {
  return readSecretPolicyStateFromDocument(
    readPolicyDocument(resolveWorkspacePolicyPath(workspacePath)),
  );
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

function matchesGlobText(candidate: unknown, expected: unknown): boolean {
  const normalized = normalizeString(candidate);
  if (!normalized) return false;
  const values = normalizeStringList(expected);
  const candidates = values.length > 0 ? values : [normalizeString(expected)];
  return candidates.some((pattern) => {
    if (!pattern) return false;
    if (pattern === '*') return true;
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(normalized);
  });
}

const SECRET_POLICY_PREDICATES: PolicyPredicateRegistry<SecretPolicyContext> = {
  secret_resolve_allowed: (context, params) => {
    const ids = params.id ?? params.secret ?? params.secretId;
    if (ids !== undefined && !matchesGlobText(context.secretId, ids)) {
      return false;
    }
    if (
      params.source !== undefined &&
      !matchesText(context.secretSource, params.source)
    ) {
      return false;
    }
    const sinks = params.sink ?? params.sinkKind ?? params.sinks;
    if (sinks !== undefined && !matchesText(context.sinkKind, sinks)) {
      return false;
    }
    if (
      params.host !== undefined &&
      !matchesNetworkHostPattern(params.host, context.host || '')
    ) {
      return false;
    }
    const selector = params.selector ?? params.selectors;
    if (
      selector !== undefined &&
      !matchesGlobText(context.selector || '', selector)
    ) {
      return false;
    }
    const skill = params.skill ?? params.skillName;
    if (skill !== undefined && !matchesText(context.skillName || '', skill)) {
      return false;
    }
    const agent = params.agent ?? params.agentId;
    if (agent !== undefined && !matchesText(context.agentId || '', agent)) {
      return false;
    }
    return true;
  },
  'secret.id': (context, params) =>
    matchesGlobText(
      context.secretId,
      params.equals ?? params.matches ?? params.in,
    ),
  'secret.source': (context, params) =>
    matchesText(context.secretSource, params.equals ?? params.in),
  'secret.sink': (context, params) =>
    matchesText(context.sinkKind, params.equals ?? params.in),
  'secret.host': (context, params) =>
    matchesNetworkHostPattern(
      params.host ?? params.equals ?? params.matches,
      context.host || '',
    ),
  'secret.selector': (context, params) =>
    matchesGlobText(
      context.selector || '',
      params.equals ?? params.matches ?? params.in,
    ),
  'skill.name': (context, params) =>
    matchesText(context.skillName || '', params.equals ?? params.in),
  'agent.id': (context, params) =>
    matchesText(context.agentId || '', params.equals ?? params.in),
};

export function evaluateSecretPolicyAccess(params: {
  state: SecretPolicyState;
  context: SecretPolicyContext;
}): {
  decision: SecretPolicyDecision;
  matchedRule?: PolicyRule<SecretPolicyDecision>;
} {
  const evaluation = evaluatePolicyRules({
    rules: params.state.rules,
    context: params.context,
    predicates: SECRET_POLICY_PREDICATES,
    defaultAction: params.state.defaultAction,
  });
  return {
    decision: evaluation.action === 'deny' ? 'deny' : 'allow',
    matchedRule: evaluation.matchedRule,
  };
}
