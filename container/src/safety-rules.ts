/**
 * Safety settings are a per-turn snapshot of authenticated gateway input.
 * Missing settings reset to all rules enabled; worker memory is never consent.
 * Unlike approval policy, this module cannot promote or authorize an action.
 */
import {
  matchSafetyRule,
  normalizeDisabledSafetyRules,
  type SafetyRule,
} from '../shared/safety-rules.js';

let disabledRuleIds: string[] = [];
export function configureSafetyRules(value: unknown): void {
  disabledRuleIds = [];
  disabledRuleIds = normalizeDisabledSafetyRules(value);
}
export function activeSafetyBlock(
  scope: SafetyRule['scope'],
  value: string,
): string | null {
  const rule = matchSafetyRule(scope, value, disabledRuleIds);
  return rule
    ? `Blocked by safety rule ${rule.id}: ${rule.reason} Approval cannot override this restriction.`
    : null;
}
