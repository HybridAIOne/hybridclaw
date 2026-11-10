/**
 * The server supplies both the installed safety catalog and its enabled state.
 * This client does not infer rules from the console build or grant approvals.
 */
import type { SafetyRulesResponse } from '@hybridclaw/shared/safety-rules';
import { requestJson } from './client';
export function fetchSafetyRules(token: string): Promise<SafetyRulesResponse> {
  return requestJson('/api/admin/safety-rules', { token });
}
export function saveSafetyRules(
  token: string,
  disabledRuleIds: string[],
  expectedDisabledRuleIds: string[],
): Promise<SafetyRulesResponse> {
  return requestJson('/api/admin/safety-rules', {
    token,
    method: 'PUT',
    body: { disabledRuleIds, expectedDisabledRuleIds },
  });
}
