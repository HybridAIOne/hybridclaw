/**
 * Secret resolution policy: whether a stored secret may reach a sink, read
 * from the workspace `policy.yaml` `secret` section. A missing section or
 * default means allow; any present value, rule key, predicate, or parameter
 * the parser does not know throws, so a typo fails the resolve instead of
 * widening a rule. NOT the network policy (deny by default);
 * `assertSecretResolveAllowed` in the gateway enforces the decision.
 */
import fs from 'node:fs';

import YAML from 'yaml';
import { globToRegExp } from '../../container/shared/policy-glob.js';
import { matchesNetworkHostPattern } from '../policy/network-policy.js';
import {
  describePolicyRuleProblem,
  evaluatePolicyRules,
  type PolicyPredicateExpression,
  type PolicyPredicateParameters,
  type PolicyPredicateRegistry,
  type PolicyRule,
} from '../policy/policy-engine.js';
import { resolveWorkspacePolicyPath } from '../policy/policy-store.js';
import { SECRET_SINK_KINDS, type SecretSinkKind } from './secret-handles.js';
import {
  normalizeSecretLower as normalizeLower,
  normalizeSecretString as normalizeString,
} from './secret-normalization.js';

export type SecretPolicyDecision = 'allow' | 'deny';

// Only stored secrets reach the policy (`assertSecretResolveAllowed`).
const SECRET_SOURCES = ['store'] as const;

export interface SecretPolicyContext {
  agentId?: string;
  skillName?: string;
  secretSource: (typeof SECRET_SOURCES)[number];
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
  const field = `secret rule #${index + 1}`;
  // No `when` matches every resolve; a present one, even empty, must parse.
  const problem = describePolicyRuleProblem(raw, SECRET_POLICY_PARAMETERS);
  if (problem) throw new Error(`${field} ${problem}`);
  const record = raw as Record<string, unknown>;
  const id = normalizeString(record.id);
  return {
    ...(id ? { id } : {}),
    when: record.when as
      | PolicyPredicateExpression
      | PolicyPredicateExpression[]
      | undefined,
    action: readAction(record.action, `${field} action`),
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

type SecretPolicyField = {
  // A closed set of context values; `*` also matches any value.
  values?: readonly string[];
  // The host matcher takes one pattern, not a list.
  single?: boolean;
  matches: (context: SecretPolicyContext, expected: unknown) => boolean;
};

const SECRET_POLICY_FIELDS = {
  id: {
    matches: (context, expected) => matchesGlobText(context.secretId, expected),
  },
  source: {
    values: SECRET_SOURCES,
    matches: (context, expected) => matchesText(context.secretSource, expected),
  },
  sink: {
    values: SECRET_SINK_KINDS,
    matches: (context, expected) => matchesText(context.sinkKind, expected),
  },
  host: {
    single: true,
    matches: (context, expected) =>
      matchesNetworkHostPattern(expected, context.host || ''),
  },
  selector: {
    matches: (context, expected) =>
      matchesGlobText(context.selector || '', expected),
  },
  skill: {
    matches: (context, expected) =>
      matchesText(context.skillName || '', expected),
  },
  agent: {
    matches: (context, expected) =>
      matchesText(context.agentId || '', expected),
  },
} satisfies Record<string, SecretPolicyField>;

type SecretPolicyFieldName = keyof typeof SECRET_POLICY_FIELDS;

// Each predicate's parameters and the context field each one matches. The
// evaluator reads parameters only through this table and the parser rejects
// any other key, so a typo cannot drop a condition. Spellings of one field are
// alternatives: a rule may set only one of them.
const SECRET_POLICY_PREDICATE_PARAMS: Record<
  string,
  Record<string, SecretPolicyFieldName>
> = {
  secret_resolve_allowed: {
    id: 'id',
    secret: 'id',
    secretId: 'id',
    source: 'source',
    sink: 'sink',
    sinkKind: 'sink',
    sinks: 'sink',
    host: 'host',
    selector: 'selector',
    selectors: 'selector',
    skill: 'skill',
    skillName: 'skill',
    agent: 'agent',
    agentId: 'agent',
  },
  'secret.id': { equals: 'id', matches: 'id', in: 'id' },
  'secret.source': { equals: 'source', in: 'source' },
  'secret.sink': { equals: 'sink', in: 'sink' },
  'secret.host': { host: 'host', equals: 'host', matches: 'host' },
  'secret.selector': {
    equals: 'selector',
    matches: 'selector',
    in: 'selector',
  },
  'skill.name': { equals: 'skill', in: 'skill' },
  'agent.id': { equals: 'agent', in: 'agent' },
};

const SECRET_POLICY_PREDICATES: PolicyPredicateRegistry<SecretPolicyContext> =
  Object.fromEntries(
    Object.entries(SECRET_POLICY_PREDICATE_PARAMS).map(([name, params]) => [
      name,
      (context: SecretPolicyContext, expression: Record<string, unknown>) =>
        Object.entries(params).every(
          ([param, field]) =>
            !Object.hasOwn(expression, param) ||
            SECRET_POLICY_FIELDS[field].matches(context, expression[param]),
        ),
    ]),
  );

function checkFieldValue(spec: SecretPolicyField, value: unknown): string {
  const entries: unknown[] =
    Array.isArray(value) && !spec.single ? value : [value];
  if (
    entries.length === 0 ||
    !entries.every((entry) => typeof entry === 'string' && entry.trim())
  ) {
    return `must be a non-empty string${spec.single ? '' : ' or list of strings'} (got ${JSON.stringify(value)})`;
  }
  if (!spec.values) return '';
  const allowed = [...spec.values, '*'];
  const invalid = entries.find(
    (entry) => !allowed.includes(normalizeLower(entry)),
  );
  return invalid === undefined
    ? ''
    : `must be one of ${allowed.join(', ')} (got ${JSON.stringify(invalid)})`;
}

// What `describePolicyRuleProblem` checks rules against. Every parameter is
// required, so a predicate must set at least one.
const SECRET_POLICY_PARAMETERS: PolicyPredicateParameters = Object.fromEntries(
  Object.entries(SECRET_POLICY_PREDICATE_PARAMS).map(([name, params]) => [
    name,
    Object.fromEntries(
      Object.entries(params).map(([param, field]) => [
        param,
        {
          group: field,
          required: true,
          check: (value: unknown) =>
            checkFieldValue(SECRET_POLICY_FIELDS[field], value),
        },
      ]),
    ),
  ]),
);

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
