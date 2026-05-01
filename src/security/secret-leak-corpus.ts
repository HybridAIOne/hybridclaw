import type {
  ConfidentialRule,
  ConfidentialRuleSet,
} from './confidential-rules.js';

const MIN_TRACKED_SECRET_LENGTH = 4;
const MAX_RULES_PER_SESSION = 100;

const resolvedSecretRulesBySession = new Map<string, ConfidentialRule[]>();

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim() || 'secret-resolution';
}

export function rememberResolvedSecretForLeakScan(params: {
  sessionId: string;
  secretId: string;
  value: string;
}): void {
  const value = params.value.trim();
  if (value.length < MIN_TRACKED_SECRET_LENGTH) return;
  const sessionId = normalizeSessionId(params.sessionId);
  const current = resolvedSecretRulesBySession.get(sessionId) || [];
  if (current.some((rule) => rule.literal === value)) return;
  if (current.length >= MAX_RULES_PER_SESSION) current.shift();
  current.push({
    id: `runtime_secret_${current.length + 1}`,
    kind: 'keyword',
    label: `resolved secret ${params.secretId}`,
    sensitivity: 'critical',
    literal: value,
    literalAliases: [],
    caseInsensitive: false,
  });
  resolvedSecretRulesBySession.set(sessionId, current);
}

export function withResolvedSecretLeakRules(
  sessionId: string,
  ruleSet: ConfidentialRuleSet,
): ConfidentialRuleSet {
  const rules = resolvedSecretRulesBySession.get(normalizeSessionId(sessionId));
  if (!rules || rules.length === 0) return ruleSet;
  return {
    rules: [...ruleSet.rules, ...rules],
    sourcePath: ruleSet.sourcePath,
  };
}
