/**
 * Safety settings are a per-turn snapshot of authenticated gateway input.
 * Missing settings reset to all rules enabled; worker memory is never consent.
 * Eval matching examines shell words without treating path directories as code.
 * Unlike approval policy, this module cannot promote or authorize an action.
 */
import path from 'node:path';
import {
  normalizeDisabledSafetyRules,
  SAFETY_RULES,
  type SafetyRule,
} from '../shared/safety-rules.js';
import { scriptCommands, shellCommandsRun } from './bash-commands.js';

let disabledRuleIds: string[] = [];
export function configureSafetyRules(value: unknown): void {
  disabledRuleIds = [];
  disabledRuleIds = normalizeDisabledSafetyRules(value);
}
export function activeSafetyBlock(
  scope: SafetyRule['scope'],
  value: string,
): string | null {
  // Heredoc bodies are not shell words; retain conservative text matching there.
  const evalInput =
    scope === 'bash' && !value.includes('<<')
      ? shellCommandsRun(scriptCommands(value))
          .flat()
          .map((word) =>
            word.includes('/') && /^[\w./*-]+$/.test(word)
              ? path.posix.basename(word)
              : word,
          )
          .join(' ')
      : value;
  const rule = SAFETY_RULES.find(
    (candidate) =>
      candidate.scope === scope &&
      !disabledRuleIds.includes(candidate.id) &&
      candidate.pattern.test(
        (candidate.id === 'eval' ? evalInput : value).toLowerCase(),
      ),
  );
  return rule
    ? `Blocked by safety rule ${rule.id}: ${rule.reason} Approval cannot override this restriction.`
    : null;
}
