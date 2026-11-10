/**
 * Safety settings are a per-turn snapshot of authenticated gateway input.
 * Missing settings reset to all rules enabled; worker memory is never consent.
 * Eval matching distinguishes environment operands and quoted Python comments
 * from executable code; denials retain every independent enabled rule.
 * Unlike approval policy, this module cannot promote or authorize an action.
 */
import path from 'node:path';
import {
  normalizeDisabledSafetyRules,
  SAFETY_RULES,
  type SafetyRule,
} from '@hybridclaw/shared/safety-rules';
import {
  commandProgram,
  HOME_VARIABLE_RE,
  PYTHON_PROGRAM_RE,
  scriptCommands,
  shellCommandsRun,
} from './bash-commands.js';
import { codeSource } from './bash-remote-code.js';
import { withoutPythonComments } from './python-data-inspection.js';

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

function evalInspectionInput(value: string): string {
  if (!value.includes('<<')) {
    return shellCommandsRun(scriptCommands(value))
      .flatMap(evalCheckWords)
      .join(' ');
  }
  if (!value.toLowerCase().includes('eval')) return value;
  // Codex, 2026-11-08: inspect only a single, quoted Python stdin program,
  // optionally after a literal cd. Other shell forms retain raw-text matching.
  const match = value.match(
    /^[ \t]*(?:cd[ \t]+[\w./~-]+[ \t]*&&[ \t]*)?([\w.]+)[ \t]+<<[ \t]*(?:'(\w+)'|"(\w+)")[ \t]*\r?\n([\s\S]*)$/,
  );
  if (!match || !PYTHON_PROGRAM_RE.test(match[1])) return value;
  const delimiter = match[2] ?? match[3];
  const lines = match[4].split('\n');
  const end = lines.findIndex((line) => line.replace(/\r$/, '') === delimiter);
  if (end < 0 || lines.slice(end + 1).some((line) => line.trim())) return value;
  const source = withoutPythonComments(lines.slice(0, end).join('\n'));
  return source === null
    ? value
    : `${value.slice(0, value.indexOf('\n'))}\n${source}\n${delimiter}`;
}

export function activeSafetyBlock(
  scope: SafetyRule['scope'],
  value: string,
): string | null {
  const evalInput =
    scope === 'bash' && !disabledRuleIds.includes('eval')
      ? evalInspectionInput(value)
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
