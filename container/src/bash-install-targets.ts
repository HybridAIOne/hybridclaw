/**
 * Explicit pip target directories are writes, even when stdout goes elsewhere.
 * Unlike the workspace fence, this only extracts recognized argument roles;
 * it does not approve installs or infer effects from package/config contents.
 */
import { PYTHON_PROGRAM_RE } from './bash-command-prefix.js';

// Value-taking input options must not turn their values into output flags.
const INPUT_OPTIONS = new Set([
  '-r',
  '--requirement',
  '-c',
  '--constraint',
  '--build-constraint',
  '-e',
  '--editable',
  '-f',
  '--find-links',
  '-i',
  '--index-url',
  '--extra-index-url',
  '-C',
  '--config-settings',
  '--python',
  '--proxy',
  '--cert',
  '--client-cert',
  '--platform',
  '--python-version',
  '--implementation',
  '--abi',
]);

export function installWriteTargets(program: string, args: string[]): string[] {
  if (PYTHON_PROGRAM_RE.test(program) && args[0] === '-m' && args[1] === 'pip')
    args = args.slice(2);
  else if (!/^pip\d*(?:\.\d+)?$/.test(program)) return [];
  const targets: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg.startsWith('--target=')) {
      targets.push(arg.slice('--target='.length));
    } else if (arg === '--target') {
      targets.push(args[++index] ?? '');
    } else if (INPUT_OPTIONS.has(arg)) {
      index++;
    } else if (/^-[^-]/.test(arg)) {
      for (let position = 1; position < arg.length; position++) {
        const flag = arg[position];
        if (flag !== 't' && !INPUT_OPTIONS.has(`-${flag}`)) continue;
        const value = arg.slice(position + 1) || args[++index] || '';
        if (flag === 't') targets.push(value);
        break;
      }
    }
  }
  return targets;
}
