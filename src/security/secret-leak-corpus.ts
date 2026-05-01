import type {
  ConfidentialRule,
  ConfidentialRuleSet,
} from './confidential-rules.js';

const MIN_TRACKED_SECRET_LENGTH = 4;
const MAX_RULES_PER_SESSION = 100;
const MAX_TRACKED_SESSIONS = 1000;

type SessionResolvedSecrets = {
  nextRuleId: number;
  rules: ConfidentialRule[];
  touchedAt: number;
};

const resolvedSecretRulesBySession = new Map<string, SessionResolvedSecrets>();

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim() || 'secret-resolution';
}

function evictOldestSessionIfNeeded(): void {
  if (resolvedSecretRulesBySession.size <= MAX_TRACKED_SESSIONS) return;
  let oldestSessionId: string | null = null;
  let oldestTouchedAt = Number.POSITIVE_INFINITY;
  for (const [sessionId, state] of resolvedSecretRulesBySession) {
    if (state.touchedAt >= oldestTouchedAt) continue;
    oldestSessionId = sessionId;
    oldestTouchedAt = state.touchedAt;
  }
  if (oldestSessionId) resolvedSecretRulesBySession.delete(oldestSessionId);
}

export function rememberResolvedSecretForLeakScan(params: {
  sessionId: string;
  secretId: string;
  value: string;
}): void {
  const value = params.value.trim();
  if (value.length < MIN_TRACKED_SECRET_LENGTH) return;
  const sessionId = normalizeSessionId(params.sessionId);
  const current = resolvedSecretRulesBySession.get(sessionId) || {
    nextRuleId: 1,
    rules: [],
    touchedAt: 0,
  };
  current.touchedAt = Date.now();
  if (current.rules.some((rule) => rule.literal === value)) {
    resolvedSecretRulesBySession.set(sessionId, current);
    evictOldestSessionIfNeeded();
    return;
  }
  if (current.rules.length >= MAX_RULES_PER_SESSION) current.rules.shift();
  current.rules.push({
    id: `runtime_secret_${current.nextRuleId}`,
    kind: 'keyword',
    label: `resolved secret ${params.secretId}`,
    sensitivity: 'critical',
    literal: value,
    literalAliases: [],
    caseInsensitive: false,
  });
  current.nextRuleId += 1;
  resolvedSecretRulesBySession.set(sessionId, current);
  evictOldestSessionIfNeeded();
}

export function withResolvedSecretLeakRules(
  sessionId: string,
  ruleSet: ConfidentialRuleSet,
): ConfidentialRuleSet {
  const state = resolvedSecretRulesBySession.get(normalizeSessionId(sessionId));
  const rules = state?.rules;
  if (!rules || rules.length === 0) return ruleSet;
  return {
    rules: [...ruleSet.rules, ...rules],
    sourcePath: ruleSet.sourcePath,
  };
}
