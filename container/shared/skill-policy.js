import { evaluatePolicyRules } from './policy-engine.js';

const SKILL_POLICY_ACTION_TYPES = new Set([
  'allow',
  'deny',
  'block',
  'warn',
  'log',
  'confirm-each',
]);

export const DEFAULT_SKILL_POLICY_ACTION = { type: 'allow' };

function normalizeString(value) {
  return String(value ?? '').trim();
}

function normalizeStringLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStringList(value) {
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

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function normalizeSkillPolicyAction(raw) {
  const rawAction = asRecord(raw);
  const type = normalizeStringLower(
    typeof raw === 'string' ? raw : rawAction.type,
  );
  if (!SKILL_POLICY_ACTION_TYPES.has(type)) return null;
  const reason = normalizeString(rawAction.reason);
  return {
    ...rawAction,
    type,
    ...(reason ? { reason } : {}),
  };
}

function normalizeSkillPolicyRule(raw) {
  const record = asRecord(raw);
  const action = normalizeSkillPolicyAction(record.action);
  if (!action) return null;
  const id = normalizeString(record.id);
  const description = normalizeString(record.description);
  return {
    ...(id ? { id } : {}),
    ...(description ? { description } : {}),
    when: record.when,
    action,
    metadata: { skillRule: raw },
  };
}

export function readSkillPolicyState(document) {
  const skill = asRecord(document?.skill);
  const rawRules = Array.isArray(skill.rules) ? skill.rules : [];
  return {
    rules: rawRules
      .map((rule) => normalizeSkillPolicyRule(rule))
      .filter(Boolean),
  };
}

function equalsText(candidate, expected) {
  const normalizedCandidate = normalizeStringLower(candidate);
  if (!normalizedCandidate) return false;
  if (Array.isArray(expected)) {
    return expected.some((entry) => normalizedCandidate === normalizeStringLower(entry));
  }
  const normalizedExpected = normalizeStringLower(expected);
  return normalizedExpected === '*' || normalizedCandidate === normalizedExpected;
}

function matchesText(candidate, params) {
  if (Object.hasOwn(params, 'equals')) return equalsText(candidate, params.equals);
  if (Object.hasOwn(params, 'in')) return equalsText(candidate, params.in);
  if (Object.hasOwn(params, 'oneOf')) return equalsText(candidate, params.oneOf);
  if (Object.hasOwn(params, 'matches')) {
    try {
      return new RegExp(String(params.matches), 'i').test(normalizeString(candidate));
    } catch {
      return false;
    }
  }
  return Boolean(normalizeString(candidate));
}

function listContains(values, params) {
  const normalized = values.map(normalizeStringLower).filter(Boolean);
  const candidates = normalizeStringList(params.includes ?? params.equals ?? params.any);
  if (candidates.length === 0) return normalized.length > 0;
  return candidates.some((candidate) => normalized.includes(normalizeStringLower(candidate)));
}

function compareNumber(value, params) {
  if (!Number.isFinite(value)) return false;
  if (Object.hasOwn(params, 'gte') && !(value >= Number(params.gte))) return false;
  if (Object.hasOwn(params, 'gt') && !(value > Number(params.gt))) return false;
  if (Object.hasOwn(params, 'lte') && !(value <= Number(params.lte))) return false;
  if (Object.hasOwn(params, 'lt') && !(value < Number(params.lt))) return false;
  if (Object.hasOwn(params, 'equals') && !(value === Number(params.equals))) {
    return false;
  }
  return true;
}

const SKILL_POLICY_PREDICATES = {
  'skill.name': (context, params) => matchesText(context.skillName, params),
  'skill.id': (context, params) => matchesText(context.skillId, params),
  'skill.source': (context, params) => matchesText(context.source, params),
  'skill.category': (context, params) => matchesText(context.category, params),
  'skill.channel': (context, params) => matchesText(context.channel, params),
  'skill.capability': (context, params) =>
    listContains(context.capabilities || [], params),
  'agent.id': (context, params) => matchesText(context.agentId, params),
  agent: (context, params) => matchesText(context.agentId, params),
  'actor.role': (context, params) => listContains(context.roles || [], params),
  'tenant.id': (context, params) => matchesText(context.tenantId, params),
  'skill.quality_score': (context, params) =>
    compareNumber(context.qualityScore, params),
};

export function evaluateSkillPolicyAccess(params) {
  const context = {
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
    predicates: SKILL_POLICY_PREDICATES,
    defaultAction: DEFAULT_SKILL_POLICY_ACTION,
  });
  const type = normalizeStringLower(evaluation.action?.type);
  return {
    decision: type === 'deny' || type === 'block' ? 'deny' : 'allow',
    action: evaluation.action || DEFAULT_SKILL_POLICY_ACTION,
    matchedRule: evaluation.matchedRule?.metadata?.skillRule,
  };
}
