/**
 * Only certified literal sed substitutions receive data-argument roles.
 * Unlike sedWriteTargets, this proves absence of script writes/execution;
 * unknown options, script files and other sed grammar remain opaque.
 */
import { redirectWidth } from './bash-command-prefix.js';

function isLiteralSubstitution(script: string): boolean {
  if (!/^s[^a-zA-Z0-9\\\s]/.test(script) || /[\r\n$`]/.test(script))
    return false;
  const delimiter = script[1];
  let index = 2;
  for (let part = 0; part < 2; part++) {
    while (index < script.length && script[index] !== delimiter) {
      if (script[index] === '\\') index++;
      index++;
    }
    if (index >= script.length) return false;
    index++;
  }
  // Codex, 2026-11-10: these substitution flags only select/print matches.
  // Execution (`e`), file output (`w`) and compound scripts stay opaque.
  return /^[0-9gpIiMm]*$/.test(script.slice(index));
}

export function sedLiteralDataArgs(
  program: string,
  args: string[],
): number[] | null {
  if (program !== 'sed' && program !== 'gsed') return null;
  const scripts: Array<{ index: number; text: string }> = [];
  let options = true;
  let bareScript = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const width = redirectWidth(args, index);
    if (width) {
      index += width - 1;
    } else if (options && arg === '--') {
      options = false;
    } else if (options && arg.startsWith('-') && arg !== '-') {
      if (/^-[nEr]+$/.test(arg)) continue;
      const expression = /^-[nEr]*e(.*)$/.exec(arg);
      if (
        expression ||
        arg === '--expression' ||
        arg.startsWith('--expression=')
      ) {
        if (bareScript) return null;
        const attached = expression?.[1] ?? arg.slice('--expression='.length);
        if (attached) scripts.push({ index, text: attached });
        else {
          index++;
          scripts.push({ index, text: args[index] ?? '' });
        }
      } else return null;
    } else if (scripts.length === 0) {
      scripts.push({ index, text: arg });
      bareScript = true;
    }
  }
  return scripts.length &&
    scripts.every(({ text }) => isLiteralSubstitution(text))
    ? scripts.map(({ index }) => index)
    : null;
}
