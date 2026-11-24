/**
 * Identifies an optional pip diagnostic that can be retried without revealing
 * configuration. Approval policy owns the refusal and the credential pin.
 */
import {
  commandArguments,
  PYTHON_PROGRAM_RE,
  type ScriptCommand,
} from './bash-commands.js';

export const PIP_CONFIG_PATH = '/etc/pip.conf';
export const PIP_CONFIG_DIAGNOSTIC_REPLAN = 'bash:pip-config-diagnostic';

export function isPipConfigDiagnostic(commands: ScriptCommand[]): boolean {
  const first = commands[0];
  if (first?.start !== 0) return false;
  const args = commandArguments(first.args);
  const configAt = /^(?:pip|pip3(?:\.\d+)?)$/.test(first.program)
    ? 0
    : PYTHON_PROGRAM_RE.test(first.program) &&
        args[0] === '-m' &&
        args[1] === 'pip'
      ? 2
      : -1;
  return (
    configAt >= 0 &&
    args[configAt] === 'config' &&
    ['list', 'debug'].includes(args[configAt + 1])
  );
}
