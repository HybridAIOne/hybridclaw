/**
 * Safety settings are a per-turn snapshot of authenticated gateway input.
 * Missing settings reset to all rules enabled; worker memory is never consent.
 * Eval matching distinguishes known environment operands from executable code;
 * denials report every enabled match, including independent source-script rules.
 * Unlike approval policy, this module cannot promote or authorize an action.
 */
import path from 'node:path';
import {
  normalizeDisabledSafetyRules,
  SAFETY_RULES,
  type SafetyRule,
} from '../shared/safety-rules.js';
import {
  commandProgram,
  HOME_VARIABLE_RE,
  scriptCommands,
  shellCommandsRun,
} from './bash-commands.js';
import { codeSource } from './bash-remote-code.js';

let disabledRuleIds: string[] = [];
export function configureSafetyRules(value: unknown): void {
  disabledRuleIds = [];
  disabledRuleIds = normalizeDisabledSafetyRules(value);
}
function evalCheckWords(words: string[]): string[] {
  const command = commandProgram(words);
  const source = codeSource({ words, ...command });
  return words.map((word, i) => {
    // A direct activation takes one environment operand, never shell source.
    // Unknown flags, wrappers and other subcommands keep conservative matching.
    if (
      !command.unresolvedPrefix &&
      command.program === 'conda' &&
      command.args.length === 2 &&
      command.args[0] === 'activate' &&
      !command.args[1].startsWith('-') &&
      i === command.start + 2
    )
      return '';
    // Only a command or script filename can use home-path shorthand here.
    // Keep home-prefixed inline code and opaque arguments visible to the rule.
    const fileOperand =
      i === command.start ||
      (source && 'file' in source && source.file === word);
    const literal = fileOperand
      ? word.replace(HOME_VARIABLE_RE, '~').replace(/^~\//, '/')
      : word;
    return literal.includes('/') && /^[\w./*-]+$/.test(literal)
      ? path.posix.basename(literal)
      : word;
  });
}

export function activeSafetyBlock(
  scope: SafetyRule['scope'],
  value: string,
): string | null {
  // Heredoc bodies are not shell words; retain conservative text matching there.
  const evalInput =
    scope === 'bash' && !value.includes('<<')
      ? shellCommandsRun(scriptCommands(value))
          .flatMap(evalCheckWords)
          .join(' ')
      : value;
  const rules = SAFETY_RULES.filter(
    (candidate) =>
      candidate.scope === scope &&
      !disabledRuleIds.includes(candidate.id) &&
      candidate.pattern.test(
        (candidate.id === 'eval' ? evalInput : value).toLowerCase(),
      ),
  );
  return rules.length > 0
    ? `${rules.map((rule) => `Blocked by safety rule ${rule.id}: ${rule.reason}`).join('\n')} Approval cannot override ${rules.length === 1 ? 'this restriction' : 'these restrictions'}.`
    : null;
}
