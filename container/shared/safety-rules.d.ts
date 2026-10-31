/** Shared safety catalog and its serialized admin view; no authorization state. */
export interface SafetyRule {
  id: string;
  scope: 'bash' | 'file-content';
  pattern: RegExp;
  reason: string;
}
export const SAFETY_RULES: readonly SafetyRule[];
export function normalizeDisabledSafetyRules(value: unknown): string[];
export function matchSafetyRule(
  scope: SafetyRule['scope'],
  value: string,
  disabledRuleIds?: readonly string[],
): SafetyRule | null;
export interface SafetyRulesResponse {
  rules: Array<
    Omit<SafetyRule, 'pattern'> & { pattern: string; enabled: boolean }
  >;
  disabledRuleIds: string[];
}
