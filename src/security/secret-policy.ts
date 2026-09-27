/**
 * Secret resolution policy: whether a stored secret may reach a sink, read
 * from the workspace `policy.yaml` `secret` section. A missing section or
 * default means allow; anything present that does not parse throws, so the
 * resolve fails instead of allowing it. NOT the network policy (deny by
 * default); `assertSecretResolveAllowed` in the gateway enforces the decision.
 */
import fs from 'node:fs';

import YAML from 'yaml';
import { globToRegExp } from '../../container/shared/policy-glob.js';
import { matchesNetworkHostPattern } from '../policy/network-policy.js';
import {
  evaluatePolicyRules,
  type PolicyPredicateExpression,
  type PolicyPredicateRegistry,
  type PolicyRule,
} from '../policy/policy-engine.js';
import { resolveWorkspacePolicyPath } from '../policy/policy-store.js';
import type { SecretSinkKind } from './secret-handles.js';
import {
  normalizeSecretLower as normalizeLower,
  normalizeSecretString as normalizeString,
} from './secret-normalization.js';

export type SecretPolicyDecision = 'allow' | 'deny';

export interface SecretPolicyContext {
  agentId?: string;
  skillName?: string;
  secretSource: 'store';
  secretId: string;
  sinkKind: SecretSinkKind;
  host?: string;
  selector?: string;
}

export interface SecretPolicyState {
  defaultAction: SecretPolicyDecision;
  rules: PolicyRule<SecretPolicyDecision>[];
}

type CachedPolicyState = {
  mtimeMs: number;
  size: number;
  state: SecretPolicyState;
};

const secretPolicyStateCache = new Map<string, CachedPolicyState>();
const globRegexCache = new Map<string, RegExp>();
const MAX_GLOB_REGEX_CACHE_ENTRIES = 256;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeString).filter(Boolean);
  }
  return [];
}

function readAction(value: unknown, field: string): SecretPolicyDecision {
  const raw = typeof value === 'string' ? value : asRecord(value).type;
  const normalized = normalizeLower(raw);
  if (normalized === 'allow') return 'allow';
  if (normalized === 'deny' || normalized === 'block') return 'deny';
  throw new Error(
    `${field} must be one of allow, deny, block (got ${JSON.stringify(value)})`,
  );
}

function readRule(
  raw: unknown,
  index: number,
): PolicyRule<SecretPolicyDecision> {
  const record = asRecord(raw);
  const id = normalizeString(record.id);
  return {
    ...(id ? { id } : {}),
    when: record.when as
      | PolicyPredicateExpression
      | PolicyPredicateExpression[]
      | undefined,
    action: readAction(record.action, `secret rule #${index + 1} action`),
    metadata: { secretRule: raw },
  };
}

export function readSecretPolicyStateFromDocument(
  document: Record<string, unknown>,
): SecretPolicyState {
  const secret = document.secret ?? {};
  if (typeof secret !== 'object' || Array.isArray(secret)) {
    throw new Error(`secret must be a mapping (got ${JSON.stringify(secret)})`);
  }
  const section = secret as Record<string, unknown>;
  const rules = section.rules ?? [];
  if (!Array.isArray(rules)) {
    throw new Error(
      `secret.rules must be a list (got ${JSON.stringify(rules)})`,
    );
  }
  return {
    // Absent or empty means allow (owner call, #982, 2026-05-13): a deny
    // default made normal stored-secret use look policy-blocked. A present
    // value must parse (owner call, 2026-09-27), so a typo such as `denied`
    // fails every resolve instead of allowing it.
    defaultAction:
      section.default == null
        ? 'allow'
        : readAction(section.default, 'secret.default'),
    rules: rules.map(readRule),
  };
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
  const policyPath = resolveWorkspacePolicyPath(workspacePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(policyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      secretPolicyStateCache.delete(policyPath);
      return readSecretPolicyStateFromDocument({});
    }
    throw err;
  }

  const cached = secretPolicyStateCache.get(policyPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.state;
  }

  const document = readPolicyDocument(policyPath);
  let state: SecretPolicyState;
  try {
    state = readSecretPolicyStateFromDocument(document);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid secret policy in ${policyPath}: ${message}`);
  }
  secretPolicyStateCache.set(policyPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    state,
  });
  return state;
}

export function clearSecretPolicyStateCache(): void {
  secretPolicyStateCache.clear();
  globRegexCache.clear();
}

function compileGlobPattern(pattern: string): RegExp {
  const cached = globRegexCache.get(pattern);
  if (cached) return cached;
  const regex = globToRegExp(pattern, 'text');
  if (globRegexCache.size >= MAX_GLOB_REGEX_CACHE_ENTRIES) {
    const oldest = globRegexCache.keys().next().value;
    if (oldest) globRegexCache.delete(oldest);
  }
  globRegexCache.set(pattern, regex);
  return regex;
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
    return compileGlobPattern(pattern).test(normalized);
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
