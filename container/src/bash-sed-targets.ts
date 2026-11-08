/**
 * In-place sed operands and backup names remain writes beside redirected logs.
 * Unlike the workspace fence, this only extracts CLI roles, not script effects.
 * Bare sed keeps both GNU/BSD interpretations; gsed uses the GNU convention.
 */
// Codex, 2026-11-07: limit generated backup names to 64 KiB per
// interpretation. Larger batches must be split; command-length policy is separate.
const MAX_BACKUP_CHARS = 64 * 1024;

export function sedWriteTargets(program: string, args: string[]): string[] {
  if (program !== 'sed' && program !== 'gsed') return [];
  return [
    ...inPlaceTargets(args, false),
    ...(program === 'sed' ? inPlaceTargets(args, true) : []),
  ];
}

function inPlaceTargets(args: string[], bsd: boolean): string[] {
  let suffix: string | null = null;
  let explicitScript = false;
  let options = true;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (!options || arg === '-' || !arg.startsWith('-')) {
      operands.push(arg);
      if (bsd) options = false;
    } else if (arg.startsWith('--')) {
      if (bsd || arg === '--help' || arg === '--version') return [];
      if (arg === '--in-place') suffix = '';
      else if (arg.startsWith('--in-place='))
        suffix = arg.slice('--in-place='.length);
      else if (/^--(?:expression|file)(?:=|$)/.test(arg)) {
        explicitScript = true;
        if (!arg.includes('=')) index++;
      } else if (arg === '--line-length') index++;
    } else {
      for (let position = 1; position < arg.length; position++) {
        const flag = arg[position];
        if (flag === 'i' || (bsd && flag === 'I')) {
          suffix = arg.slice(position + 1) || (bsd ? args[++index] : '') || '';
          break;
        }
        if (flag === 'e' || flag === 'f' || (!bsd && flag === 'l')) {
          if (flag !== 'l') explicitScript = true;
          if (position + 1 === arg.length) index++;
          break;
        }
        if (!bsd && flag === 'I') return [];
      }
    }
  }
  if (suffix === null) return [];
  const files = explicitScript ? operands : operands.slice(1);
  const targets = [...files];
  // xargs may supply the filenames later; a fixed backup prefix still counts.
  if (!bsd && files.length === 0 && suffix.includes('*')) targets.push(suffix);
  if (suffix) {
    let stars = 0;
    if (!bsd) for (const char of suffix) if (char === '*') stars++;
    let remaining = MAX_BACKUP_CHARS;
    for (const file of files) {
      remaining -= stars
        ? suffix.length + stars * (file.length - 1)
        : file.length + suffix.length;
      if (remaining < 0) {
        throw new RangeError(
          'sed backup paths exceed the inspection limit; split the command into smaller batches.',
        );
      }
      targets.push(
        stars > 0 ? suffix.replaceAll('*', () => file) : file + suffix,
      );
    }
  }
  return targets;
}
