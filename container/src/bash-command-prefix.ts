/**
 * Prefix parsing retains literal operators and exposes only known argv boundaries.
 * Unresolved wrappers stay explicit; option values never become executables.
 * Unlike bash-commands, this does not follow pipelines, resolve cwd or grant access.
 */
import path from 'node:path';
import { isShellRedirect, sliceShellWords } from './bash-word-roles.js';

export const PYTHON_PROGRAM_RE = /^python\d*(?:\.\d+)?$/;

interface Prefix {
  values?: readonly string[];
  flags?: string;
  longFlags?: readonly string[];
  external?: true;
  duration?: true;
}

// One catalog for recognized prefixes and their supported option arity. Modes
// that change argv or cwd remain unresolved rather than guessed (Codex security
// fix, 2026-11-07); interpreting those modes is deliberately deferred.
const PREFIXES = new Map<string, Prefix>([
  ['!', {}],
  ['{', {}],
  ['builtin', {}],
  ['command', { flags: 'p' }],
  ['do', {}],
  ['elif', {}],
  ['else', {}],
  ['exec', { flags: 'cl', values: ['-a'] }],
  ['if', {}],
  ['then', {}],
  ['until', {}],
  ['while', {}],
  ['doas', { external: true, flags: 'nL', values: ['-u', '-a'] }],
  [
    'env',
    {
      external: true,
      flags: 'i0v',
      longFlags: ['--ignore-environment', '--null', '--debug'],
      values: ['-u', '--unset'],
    },
  ],
  ['nice', { external: true, values: ['-n', '--adjustment'] }],
  ['nohup', { external: true }],
  [
    'stdbuf',
    {
      external: true,
      values: ['-i', '-o', '-e', '--input', '--output', '--error'],
    },
  ],
  [
    'sudo',
    {
      external: true,
      flags: 'ABbEHkNnPS',
      values: [
        '-u',
        '--user',
        '-g',
        '--group',
        '-h',
        '--host',
        '-p',
        '--prompt',
        '-C',
        '--close-from',
        '-T',
        '--command-timeout',
        '-r',
        '--role',
        '-t',
        '--type',
      ],
    },
  ],
  ['time', { external: true, flags: 'pav', values: ['-f', '--format'] }],
  [
    'timeout',
    {
      external: true,
      flags: 'v',
      longFlags: ['--foreground', '--preserve-status', '--verbose'],
      values: ['-s', '--signal', '-k', '--kill-after'],
      duration: true,
    },
  ],
]);
const REDIRECT_RE = /^(?:\d+|&)?[<>]/;
const BARE_REDIRECT_RE = /^(?:\d+|&)?[<>]+&?$/;

/** Literal command lookups never execute their operands, including combined flags. */
export function isCommandLookup(words: string[], start = 0): boolean {
  if (words[start] !== 'command') return false;
  let lookup = false;
  for (let index = start + 1; index < words.length; index++) {
    const option = words[index];
    const width = redirectWidth(words, index);
    if (width) {
      index += width - 1;
      continue;
    }
    if (option === '--' || !option.startsWith('-') || option === '-') break;
    if (!/^-[pvV]+$/.test(option)) return false;
    if (/[vV]/.test(option)) lookup = true;
  }
  return lookup;
}

// Words a redirection spans: `>out` and `2>&1` are one, a bare `>` also takes
// the next word as its target.
export function redirectWidth(words: readonly string[], index: number): number {
  if (isShellRedirect(words, index) === false) return 0;
  const word = words[index];
  if (!REDIRECT_RE.test(word)) return 0;
  return BARE_REDIRECT_RE.test(word) ? 2 : 1;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export interface CommandProgram {
  start: number;
  program: string;
  args: string[];
  unresolvedPrefix?: true;
}

// Number of argv words consumed by an option; null means its boundary is unknown.
function optionWidth(
  word: string,
  name: string,
  prefix: Prefix,
): number | null {
  if (word === '--' || (name === 'env' && word === '-')) return 1;
  if (name === 'nice' && /^-\d+$/.test(word)) return 1;
  if (word.startsWith('--')) {
    const equal = word.indexOf('=');
    const flag = equal < 0 ? word : word.slice(0, equal);
    if (prefix.values?.includes(flag)) return equal < 0 ? 2 : 1;
    return prefix.longFlags?.includes(word) ? 1 : null;
  }
  for (let i = 1; i < word.length; i += 1) {
    if (prefix.values?.includes(`-${word[i]}`))
      return i === word.length - 1 ? 2 : 1;
    if (!prefix.flags?.includes(word[i])) return null;
  }
  return word.length > 1 ? 1 : null;
}

export function commandProgram(words: string[]): CommandProgram {
  let active:
    | {
        name: string;
        prefix: Prefix;
        start: number;
        options: boolean;
        duration: boolean;
      }
    | undefined;
  const result = (start: number, unresolved = false): CommandProgram => ({
    start,
    program: path.posix.basename(words[start] ?? '').toLowerCase(),
    args: sliceShellWords(words, start + 1),
    ...(unresolved ? { unresolvedPrefix: true as const } : {}),
  });
  for (let start = 0; start < words.length; start += 1) {
    const word = words[start];
    if (isCommandLookup(words, start)) return result(words.length);
    if (active?.options && word.startsWith('-')) {
      const width = optionWidth(word, active.name, active.prefix);
      if (width === null) return result(active.start, true);
      if (word === '--') active.options = false;
      start += width - 1;
      continue;
    }
    if (active?.duration) {
      active.duration = false;
      active.options = false;
      continue;
    }
    if (ASSIGNMENT_RE.test(word)) continue;
    const prefix = PREFIXES.get(word);
    if (prefix) {
      active = {
        name: word,
        prefix,
        start,
        options: true,
        duration: prefix.duration === true,
      };
      continue;
    }
    // Keep the path itself: ./env may be a downloaded executable. Its name
    // suggests a wrapper but cannot prove the executable's implementation.
    if (word.includes('/') && PREFIXES.get(path.posix.basename(word))?.external)
      return result(start, true);
    return result(start);
  }
  return result(words.length);
}
