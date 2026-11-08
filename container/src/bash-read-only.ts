/**
 * Read-only shell recognition has one whitelist and literal diagnostic grammar.
 * Unlike approval-policy, it grants no permission: paths, redirects, fetched
 * code and whole-script effects still face that policy. Unknown diagnostic
 * options and dynamic operands never gain read-only classification here.
 */
import { isCommandLookup, redirectWidth } from './bash-commands.js';
import { isReadOnlyDateCommand } from './bash-date.js';

export const READ_ONLY_PDF_SCRIPT_RE =
  /^\s*node\s+skills\/pdf\/scripts\/(?:extract_pdf_text|check_fillable_fields|extract_form_field_info|extract_form_structure)\.mjs\b/i;
const READ_ONLY_BASH_RE =
  /^\s*(ls|pwd|cat|head|tail|wc|rg|grep|find|date|git\s+(status|log|diff|show)|npm\s+test|pnpm\s+test|yarn\s+test|vitest|pytest|phpunit|node\s+--version|npm\s+--version|pnpm\s+--version|yarn\s+--version)\b/i;

export function isReadOnlyCommand(words: string[]): boolean {
  if (words[0] === 'date') return isReadOnlyDateCommand(words);
  const text = words.join(' ');
  // Echo can report a diagnostic fallback within a read-only chain; it does
  // not satisfy the first-command gate.
  return (
    words[0] === 'echo' ||
    isReadOnlyDiagnosticCommand(words) ||
    READ_ONLY_BASH_RE.test(text) ||
    READ_ONLY_PDF_SCRIPT_RE.test(text)
  );
}

function directoryChange(args: string[]): boolean {
  let index = 0;
  while (args[index] === '-L' || args[index] === '-P') index++;
  const separator = args[index] === '--';
  if (separator) index++;
  return (
    args.length === index + 1 &&
    args[index] !== '-' &&
    (separator || !args[index].startsWith('-'))
  );
}

// Codex diagnostic fix, 2026-11-07: Poppler's display flags are read-only;
// password arguments and unrecognized options retain normal classification.
const PDF_DISPLAY_FLAGS = new Set([
  '-box',
  '-meta',
  '-custom',
  '-js',
  '-struct',
  '-struct-text',
  '-isodates',
  '-rawdates',
  '-dests',
  '-url',
  '-listenc',
  '-v',
  '-h',
  '-help',
  '--help',
]);

function pdfMetadata(args: string[]): boolean {
  let files = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (PDF_DISPLAY_FLAGS.has(arg)) continue;
    if (arg === '-f' || arg === '-l') {
      if (!/^[1-9][0-9]*$/.test(args[++index] ?? '')) return false;
    } else if (arg === '-enc') {
      if (!/^[A-Za-z0-9_-]+$/.test(args[++index] ?? '')) return false;
    } else if (arg.startsWith('-') && arg !== '-') {
      return false;
    } else if (++files > 1) {
      return false;
    }
  }
  return true;
}

// Codex diagnostic fix, 2026-11-07: standard od display formats and explicit
// byte ranges are read-only. Unknown extensions retain normal classification.
const OD_DISPLAY_FLAGS = 'aBbcDdeFfHhIiLlOosvXx';
const OD_BYTE_COUNT = /^(?:0x[0-9a-fA-F]+|[0-9]+)[bBkKmMgG]?$/;
const OD_VALUE_FLAGS: Record<string, RegExp> = {
  A: /^[doxn]$/,
  j: OD_BYTE_COUNT,
  N: OD_BYTE_COUNT,
  t: /^(?:[ac]|[doux](?:[CSIL]|[1-9][0-9]*)?|f(?:[FDL]|[1-9][0-9]*)?)+$/,
};

function byteDump(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') return true;
    if (!arg.startsWith('-') || arg === '-') continue;
    for (let offset = 1; offset < arg.length; offset++) {
      const flag = arg[offset];
      if (OD_DISPLAY_FLAGS.includes(flag)) continue;
      const pattern = OD_VALUE_FLAGS[flag];
      if (!pattern) return false;
      const value = arg.slice(offset + 1) || args[++index];
      if (!value || !pattern.test(value)) return false;
      break;
    }
  }
  return true;
}

function fileFormat(args: string[]): boolean {
  let options = true;
  for (const argument of args) {
    if (options && argument === '--') {
      options = false;
      continue;
    }
    if (
      options &&
      argument.startsWith('-') &&
      argument !== '-' &&
      !/^-[bhiILNn]+$/.test(argument) &&
      !FILE_DISPLAY_FLAGS.has(argument)
    )
      return false;
  }
  return true;
}

// Codex, 2026-11-08: literal format displays are read-only; compilation,
// timestamp restoration, indirect file lists and decompression stay classified.
const FILE_DISPLAY_FLAGS = new Set([
  '--brief',
  '--mime',
  '--mime-type',
  '--mime-encoding',
  '--dereference',
  '--no-dereference',
  '--no-buffer',
  '--no-pad',
]);

const DIAGNOSTICS: Record<string, (args: string[]) => boolean> = {
  cd: directoryChange,
  file: fileFormat,
  command: (args) => isCommandLookup(['command', ...args]),
  pdfinfo: pdfMetadata,
  od: byteDump,
};

function isReadOnlyDiagnosticCommand(
  words: string[],
  firstSurface?: string,
): boolean {
  const name = words[0];
  if (!Object.hasOwn(DIAGNOSTICS, name)) return false;
  // Preserve the first-command gate: quoted names, wrappers and leading groups
  // do not gain green classification from this diagnostic recognizer.
  if (
    firstSurface !== undefined &&
    firstSurface.match(/^\s*([a-z]+)(?=\s|$)/)?.[1] !== name
  )
    return false;
  if (words.slice(1).some((arg) => /[$`*?[\]{}~]/.test(arg))) return false;
  const args: string[] = [];
  for (let index = 1; index < words.length; index++) {
    const arg = words[index];
    const width = redirectWidth(arg);
    if (width) index += width - 1;
    else args.push(arg);
  }
  return DIAGNOSTICS[name](args);
}

export function isReadOnlyBashSurface(
  words: string[],
  surface: string,
): boolean {
  return (
    READ_ONLY_BASH_RE.test(surface) ||
    isReadOnlyDiagnosticCommand(words, surface)
  );
}
