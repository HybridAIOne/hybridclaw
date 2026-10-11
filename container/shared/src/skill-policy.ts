/**
 * Skill policy: the `skill.rules` section of `policy.yaml`, deciding whether
 * an agent may load a skill. The default is allow, so an unreadable rule is
 * enforced as deny and never throws (the loader treats a throw as "no rules"):
 * an unknown action keeps the rule's `when`, anything else denies every skill.
 * NOT the static `skills.disabled` config, which is applied before these rules.
 */
import type {
  PolicyParameterSpec,
  PolicyPredicateExpression,
} from './policy-engine.js';
import {
  checkPolicyText,
  describePolicyRuleProblem,
  evaluatePolicyRules,
} from './policy-engine.js';
import { readFiniteNumber } from './primitive-values.js';

export type SkillPolicyActionType =
  | 'allow'
  | 'deny'
  | 'block'
  | 'warn'
  | 'log'
  | 'confirm-each';

export interface SkillPolicyAction {
  type: SkillPolicyActionType;
  reason?: string;
  [key: string]: unknown;
}

export interface SkillPolicyRule {
  id?: string;
  description?: string;
  when?: PolicyPredicateExpression | PolicyPredicateExpression[];
  action: SkillPolicyAction;
  metadata?: Record<string, unknown>;
}

export interface SkillPolicyState {
  rules: SkillPolicyRule[];
}

export interface SkillPolicyAccessInput {
  rules: SkillPolicyRule[];
  agentId: string;
  skillName: string;
  skillId?: string;
  source?: string;
  category?: string;
  channel?: string;
  capabilities?: string[];
  roles?: string[];
  tenantId?: string;
  qualityScore?: number;
}

export interface SkillPolicyAccessEvaluation {
  decision: 'allow' | 'deny';
  action: SkillPolicyAction;
  matchedRule?: SkillPolicyRule;
}

interface SkillPolicyContext {
  agentId: string;
  skillName: string;
  skillId: string;
  source: string;
  category: string;
  channel: string;
  capabilities: string[];
  roles: string[];
  tenantId: string;
  qualityScore: number;
}

interface SkillPolicyParameter extends PolicyParameterSpec {
  match(value: unknown, expected: unknown): boolean;
}

interface SkillPolicyFieldKind {
  bare(value: unknown): boolean;
  parameters: Record<string, SkillPolicyParameter>;
}

const SKILL_POLICY_ACTION_TYPES = new Set<string>([
  'allow',
  'deny',
  'block',
  'warn',
  'log',
  'confirm-each',
]);

export const DEFAULT_SKILL_POLICY_ACTION: SkillPolicyAction = { type: 'allow' };

function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeStringLower(value: unknown): string {
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeSkillPolicyAction(raw: unknown): SkillPolicyAction | null {
  const rawAction = asRecord(raw);
  const type = normalizeStringLower(
    typeof raw === 'string' ? raw : rawAction.type,
  );
  if (!SKILL_POLICY_ACTION_TYPES.has(type)) return null;
  const reason = normalizeString(rawAction.reason);
  return {
    ...rawAction,
    type: type as SkillPolicyActionType,
    ...(reason ? { reason } : {}),
  };
}

function normalizeSkillPolicyRule(
  raw: unknown,
  index: number,
): SkillPolicyRule {
  const record = asRecord(raw);
  const id = normalizeString(record.id);
  const description = normalizeString(record.description);
  const problem = describePolicyRuleProblem(raw, SKILL_POLICY_PARAMETERS);
  const action = problem ? null : normalizeSkillPolicyAction(record.action);
  return {
    ...(id ? { id } : {}),
    ...(description ? { description } : {}),
    // An unreadable rule covers every skill; an unknown action keeps `when`.
    when: problem ? undefined : (record.when as SkillPolicyRule['when']),
    action: action ?? {
      type: 'deny',
      reason: `Unreadable skill rule #${index + 1}${problem ? ` ${problem}` : ''}, enforced as deny`,
    },
    metadata: { skillRule: raw },
  };
}

export function readSkillPolicyState(
  document: Record<string, unknown>,
): SkillPolicyState {
  const skill = asRecord(document?.skill);
  const rawRules = Array.isArray(skill.rules) ? skill.rules : [];
  return {
    rules: rawRules.map(normalizeSkillPolicyRule),
  };
}

function equalsText(candidate: unknown, expected: unknown): boolean {
  const normalizedCandidate = normalizeStringLower(candidate);
  if (!normalizedCandidate) return false;
  if (Array.isArray(expected)) {
    return expected.some(
      (entry) => normalizedCandidate === normalizeStringLower(entry),
    );
  }
  const normalizedExpected = normalizeStringLower(expected);
  return (
    normalizedExpected === '*' || normalizedCandidate === normalizedExpected
  );
}

function matchesPattern(candidate: unknown, pattern: unknown): boolean {
  try {
    return new RegExp(String(pattern), 'i').test(normalizeString(candidate));
  } catch {
    return false;
  }
}

function checkPattern(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return 'must be a regular expression';
  }
  try {
    new RegExp(value, 'i');
    return '';
  } catch {
    return 'must be a valid regular expression';
  }
}

function listContains(
  values: string[] | undefined,
  expected?: unknown,
): boolean {
  const normalized = (values || []).map(normalizeStringLower).filter(Boolean);
  const candidates = normalizeStringList(expected);
  if (candidates.length === 0) return normalized.length > 0;
  return candidates.some((candidate) =>
    normalized.includes(normalizeStringLower(candidate)),
  );
}

function numberBound(
  compare: (value: number, bound: number) => boolean,
): SkillPolicyParameter {
  return {
    check: (value: unknown) =>
      readFiniteNumber(value) === null ? 'must be a number' : '',
    match: (value: number, bound: unknown) =>
      Number.isFinite(value) && compare(value, Number(bound)),
  };
}

// Parameters per kind of context field. Keys in one group are alternatives. A
// predicate that sets none of its parameters matches when the field is set.
const TEXT: SkillPolicyFieldKind = {
  bare: (value: unknown) => Boolean(normalizeString(value)),
  parameters: {
    equals: { group: 'value', check: checkPolicyText, match: equalsText },
    in: { group: 'value', check: checkPolicyText, match: equalsText },
    oneOf: { group: 'value', check: checkPolicyText, match: equalsText },
    matches: { group: 'value', check: checkPattern, match: matchesPattern },
  },
};
const LIST: SkillPolicyFieldKind = {
  bare: (values: string[]) => listContains(values),
  parameters: {
    includes: { group: 'value', check: checkPolicyText, match: listContains },
    equals: { group: 'value', check: checkPolicyText, match: listContains },
    any: { group: 'value', check: checkPolicyText, match: listContains },
  },
};
const NUMBER: SkillPolicyFieldKind = {
  bare: Number.isFinite,
  parameters: {
    gte: numberBound((value, bound) => value >= bound),
    gt: numberBound((value, bound) => value > bound),
    lte: numberBound((value, bound) => value <= bound),
    lt: numberBound((value, bound) => value < bound),
    equals: numberBound((value, bound) => value === bound),
  },
};

const SKILL_POLICY_PREDICATES: Record<
  string,
  { field: keyof SkillPolicyContext; kind: SkillPolicyFieldKind }
> = {
  'skill.name': { field: 'skillName', kind: TEXT },
  'skill.id': { field: 'skillId', kind: TEXT },
  'skill.source': { field: 'source', kind: TEXT },
  'skill.category': { field: 'category', kind: TEXT },
  'skill.channel': { field: 'channel', kind: TEXT },
  'skill.capability': { field: 'capabilities', kind: LIST },
  'agent.id': { field: 'agentId', kind: TEXT },
  agent: { field: 'agentId', kind: TEXT },
  'actor.role': { field: 'roles', kind: LIST },
  'tenant.id': { field: 'tenantId', kind: TEXT },
  'skill.quality_score': { field: 'qualityScore', kind: NUMBER },
};

// The parser accepts exactly the parameters the evaluator reads.
const SKILL_POLICY_PARAMETERS = Object.fromEntries(
  Object.entries(SKILL_POLICY_PREDICATES).map(([name, { kind }]) => [
    name,
    kind.parameters,
  ]),
);

const SKILL_POLICY_EVALUATORS = Object.fromEntries(
  Object.entries(SKILL_POLICY_PREDICATES).map(([name, { field, kind }]) => [
    name,
    (context: SkillPolicyContext, node: Record<string, unknown>) => {
      const set = Object.keys(kind.parameters).filter((key) =>
        Object.hasOwn(node, key),
      );
      return set.length === 0
        ? kind.bare(context[field])
        : set.every((key) =>
            kind.parameters[key].match(context[field], node[key]),
          );
    },
  ]),
);

export function evaluateSkillPolicyAccess(
  params: SkillPolicyAccessInput,
): SkillPolicyAccessEvaluation {
  const context: SkillPolicyContext = {
    agentId: normalizeString(params.agentId),
    skillName: normalizeString(params.skillName),
    skillId: normalizeString(params.skillId),
    source: normalizeString(params.source),
    category: normalizeString(params.category),
    channel: normalizeString(params.channel),
    capabilities: normalizeStringList(params.capabilities),
    roles: normalizeStringList(params.roles),
    tenantId: normalizeString(params.tenantId),
    qualityScore: Number(params.qualityScore),
  };
  const evaluation = evaluatePolicyRules({
    rules: params.rules || [],
    context,
    predicates: SKILL_POLICY_EVALUATORS,
    defaultAction: DEFAULT_SKILL_POLICY_ACTION,
  });
  const type = normalizeStringLower(evaluation.action?.type);
  return {
    decision: type === 'deny' || type === 'block' ? 'deny' : 'allow',
    action: evaluation.action || DEFAULT_SKILL_POLICY_ACTION,
    matchedRule: evaluation.matchedRule?.metadata?.skillRule as
      | SkillPolicyRule
      | undefined,
  };
}
