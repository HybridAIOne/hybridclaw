/**
 * Bash command analysis for the approval policy: the simple commands a script
 * runs (`splitShellCommands`), operands that name a pinned path, and recursive
 * reads (`grep -r`, `find -exec`, `find | xargs`) that reach `.env*`, `/etc`,
 * or `~/.ssh` unnamed. Static: variables, interpreter scripts, and an earlier
 * call's `cd` escape it. NOT a sandbox, NOT the grep tool's walk filter.
 */
import path from 'node:path';
import { HARD_PINNED_PATH_PATTERNS } from './pinned-paths.js';
import { expandUserPath } from './runtime-paths.js';

export interface BashPinnedReach {
  // Pinned paths the command names, as written or resolved against its `cd`.
  namedPaths: string[];
  // The first recursive read that can reach pinned files it does not name.
  walk: { program: string; reaches: string[] } | null;
}

// Sample file names for each slash-free hard pattern. A walk filter that lets
// any sample through can read that pattern's files, so an exclusion counts
// only when it rejects every sample.
export const PINNED_NAME_SAMPLES: ReadonlyMap<string, readonly string[]> =
  new Map([['.env*', ['.env', '.envrc', '.env.local', '.env.production']]]);

// Programs that print only names or metadata of the files they are handed.
const NAME_ONLY_PROGRAMS = new Set([
  'basename',
  'dirname',
  'du',
  'echo',
  'file',
  'ls',
  'printf',
  'readlink',
  'realpath',
  'stat',
  'wc',
]);
// Words before the program itself: keywords and wrappers such as `env -i`.
const COMMAND_PREFIX_WORDS = new Set([
  '!',
  '{',
  'builtin',
  'command',
  'do',
  'doas',
  'elif',
  'else',
  'env',
  'exec',
  'if',
  'nice',
  'nohup',
  'stdbuf',
  'sudo',
  'then',
  'time',
  'timeout',
  'until',
  'while',
]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const REDIRECT_RE = /^(?:\d+|&)?[<>]/;
const BARE_REDIRECT_RE = /^(?:\d+|&)?[<>]+&?$/;
const GLOB_CHAR_RE = /[*?[]/;
const EXCLUDE_ASSIGNMENT_RE = /^--exclude(?:-dir)?=/;
const EXCLUDE_OPTIONS = new Set(['--exclude', '--exclude-dir']);
const NEGATIONS = new Set(['!', '-not']);
const FIND_PATH_TESTS = new Set([
  '-iname',
  '-ipath',
  '-iwholename',
  '-name',
  '-path',
  '-wholename',
]);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const GREP_VALUE_FLAGS = 'ABCDdefm';
const GREP_VALUE_OPTIONS = new Set([
  '--after-context',
  '--before-context',
  '--binary-files',
  '--context',
  '--devices',
  '--directories',
  '--exclude',
  '--exclude-dir',
  '--exclude-from',
  '--file',
  '--group-separator',
  '--include',
  '--label',
  '--max-count',
  '--regexp',
]);
const RG_VALUE_FLAGS = 'ABCEMTdefgjmrt';
const RG_VALUE_OPTIONS = new Set([
  '--after-context',
  '--before-context',
  '--color',
  '--colors',
  '--context',
  '--context-separator',
  '--dfa-size-limit',
  '--encoding',
  '--engine',
  '--field-context-separator',
  '--field-match-separator',
  '--file',
  '--glob',
  '--hostname-bin',
  '--hyperlink-format',
  '--iglob',
  '--ignore-file',
  '--max-columns',
  '--max-count',
  '--max-depth',
  '--max-filesize',
  '--path-separator',
  '--pre',
  '--pre-glob',
  '--regex-size-limit',
  '--regexp',
  '--replace',
  '--sort',
  '--sortr',
  '--threads',
  '--type',
  '--type-add',
  '--type-clear',
  '--type-not',
]);
const XARGS_VALUE_FLAGS = new Set([
  '-E',
  '-I',
  '-L',
  '-P',
  '-a',
  '-d',
  '-n',
  '-s',
]);
const SHELL_PROGRAMS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);
const MAX_NESTED_SCRIPT_DEPTH = 3;

interface ShellCommand {
  words: string[];
  // Reads the previous command's output through `|`.
  piped: boolean;
}

// The files a walk lets through, by base name and by where it starts.
interface Walk {
  roots: string[];
  admits(name: string): boolean;
}

interface ProgramScan {
  // Arg indexes that are not file operands: search patterns, printed text.
  nonPathArgs: number[];
  walk: Walk | null;
  // Whether the program reads the contents of the files it reaches.
  reads: boolean;
}

// '' is the starting directory (the workspace); null is unknown (`cd -`).
type Cwd = string | null;

interface SubstitutionFrame {
  words: string[];
  word: string;
  quote: '"' | null;
  closer: ')' | '`';
  depth: number;
  piped: boolean;
}

// Splits a command into simple commands the way bash reads it: quotes group,
// an unquoted `\x` is `x`, `$(...)` and backticks are commands of their own,
// and `;`, `|`, `&`, `(`, `)`, and newlines separate (`2>&1` keeps its `&`).
export function splitShellCommands(input: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  const frames: SubstitutionFrame[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let piped = false;

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (pipeNext = false) => {
    endWord();
    if (words.length > 0) {
      commands.push({ words, piped });
      piped = pipeNext;
    } else if (pipeNext) {
      piped = true;
    }
    words = [];
  };
  const openSubstitution = (closer: ')' | '`', outerQuote: '"' | null) => {
    frames.push({ words, word, quote: outerQuote, closer, depth, piped });
    words = [];
    word = '';
    inWord = false;
    quote = null;
    depth = 0;
    piped = false;
  };
  const closeSubstitution = () => {
    endCommand();
    const frame = frames.pop() as SubstitutionFrame;
    words = frame.words;
    word = `${frame.word}$()`;
    inWord = true;
    quote = frame.quote;
    depth = frame.depth;
    piped = frame.piped;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === '`' && frames.at(-1)?.closer === '`') {
      closeSubstitution();
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (
        char === '\\' &&
        next !== undefined &&
        '$`"\\'.includes(next)
      ) {
        word += next;
        index += 1;
      } else if (char === '$' && next === '(') {
        openSubstitution(')', '"');
        index += 1;
      } else if (char === '`') {
        openSubstitution('`', '"');
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '\\') {
      if (next !== undefined && next !== '\n') {
        word += next;
        inWord = true;
      }
      index += 1;
    } else if (char === '#' && !inWord) {
      while (index + 1 < input.length && input[index + 1] !== '\n') index += 1;
    } else if (char === '$' && next === '(') {
      openSubstitution(')', null);
      index += 1;
    } else if (char === '`') {
      openSubstitution('`', null);
    } else if (char === ')' && depth === 0 && frames.at(-1)?.closer === ')') {
      closeSubstitution();
    } else if (char === '(' || char === ')') {
      depth = Math.max(0, depth + (char === '(' ? 1 : -1));
      endCommand();
    } else if (char === '|') {
      if (next === '|') index += 1;
      else if (next === '&') index += 1;
      endCommand(next !== '|');
    } else if (
      char === ';' ||
      char === '\n' ||
      (char === '&' &&
        input[index - 1] !== '>' &&
        input[index - 1] !== '<' &&
        next !== '>')
    ) {
      if (char === '&' && next === '&') index += 1;
      endCommand();
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  while (frames.length > 0) closeSubstitution();
  endCommand();
  return commands;
}

// Words a redirection spans: `>out` and `2>&1` are one, a bare `>` also takes
// the next word as its target.
function redirectWidth(word: string): number {
  if (!REDIRECT_RE.test(word)) return 0;
  return BARE_REDIRECT_RE.test(word) ? 2 : 1;
}

function programIndex(words: string[]): number {
  let index = 0;
  let wrapped = false;
  for (; index < words.length; index += 1) {
    const word = words[index];
    if (COMMAND_PREFIX_WORDS.has(word)) wrapped = true;
    else if (!ASSIGNMENT_RE.test(word) && !(wrapped && /^[-\d]/.test(word))) {
      break;
    }
  }
  return index;
}

function splitLongOption(arg: string): [string, string | undefined] {
  const equals = arg.indexOf('=');
  return equals < 0
    ? [arg, undefined]
    : [arg.slice(0, equals), arg.slice(equals + 1)];
}

// Base-name glob as grep --include, find -name, and rg -g apply it: unlike
// bash, `*` and `?` also match a leading `.`. undefined when a bracket
// expression does not compile; callers then assume the file gets through.
function globMatchesName(
  glob: string,
  name: string,
  caseInsensitive: boolean,
): boolean | undefined {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = glob.indexOf(']', index + 2);
      if (close < 0) {
        source += '\\[';
        continue;
      }
      const body = glob
        .slice(index + 1, close)
        .replace(/\\/g, '\\\\')
        .replace(/^!/, '^')
        .replace(/^(\^?)\]/, '$1\\]');
      source += `[${body}]`;
      index = close;
    } else if (char === '\\' && index + 1 < glob.length) {
      index += 1;
      source += glob[index].replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '').test(name);
  } catch {
    return undefined;
  }
}

// GNU grep: the last --include/--exclude matching a name decides; a name no
// filter matches is searched unless the first filter is an --include.
function grepAdmits(
  filters: Array<{ include: boolean; glob: string }>,
  name: string,
): boolean {
  let admitted: boolean | null = null;
  for (const filter of filters) {
    if (globMatchesName(filter.glob, name, false) ?? filter.include) {
      admitted = filter.include;
    }
  }
  if (admitted !== null) return admitted;
  return filters[0]?.include !== true;
}

// ripgrep: the last matching -g wins (`!` ignores), any whitelist glob hides
// unmatched files, and hidden files need --hidden. Globs with a `/` match
// paths, so they only count toward searching a name, never toward skipping it.
function rgAdmits(
  globs: Array<{ glob: string; caseInsensitive: boolean }>,
  hidden: boolean,
  name: string,
): boolean {
  let admitted: boolean | null = null;
  for (const { glob, caseInsensitive } of globs) {
    const negated = glob.startsWith('!');
    const body = glob.replace(/^!/, '').replace(/^(?:\*\*\/)+/, '');
    const lastSegment = body.slice(body.lastIndexOf('/') + 1);
    const matches = !body.includes('/')
      ? (globMatchesName(body, name, caseInsensitive) ?? !negated)
      : !negated &&
        (lastSegment === '' ||
          lastSegment === '**' ||
          (globMatchesName(lastSegment, name, caseInsensitive) ?? true));
    if (matches) admitted = !negated;
  }
  if (admitted !== null) return admitted;
  if (globs.some(({ glob }) => !glob.startsWith('!'))) return false;
  return hidden;
}

function scanGrep(args: string[]): ProgramScan {
  let recursive = false;
  let patternGiven = false;
  const filters: Array<{ include: boolean; glob: string }> = [];
  const nonPathArgs: number[] = [];
  const operands: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const width = redirectWidth(arg);
    if (width > 0) {
      index += width - 1;
    } else if (arg === '--') {
      for (let rest = index + 1; rest < args.length; rest += 1) {
        operands.push(rest);
      }
      break;
    } else if (arg.startsWith('--')) {
      const [name, inline] = splitLongOption(arg);
      let valueAt = -1;
      if (inline === undefined && GREP_VALUE_OPTIONS.has(name)) {
        index += 1;
        valueAt = index;
      }
      const value = inline ?? args[valueAt];
      if (
        name === '--recursive' ||
        name === '--dereference-recursive' ||
        (name === '--directories' && value === 'recurse')
      ) {
        recursive = true;
      }
      if (name === '--regexp' || name === '--file') patternGiven = true;
      if (name === '--regexp' && valueAt >= 0) nonPathArgs.push(valueAt);
      if ((name === '--include' || name === '--exclude') && value) {
        filters.push({ include: name === '--include', glob: value });
      }
    } else if (arg.length > 1 && arg.startsWith('-')) {
      for (let position = 1; position < arg.length; position += 1) {
        const flag = arg[position];
        if (flag === 'r' || flag === 'R') recursive = true;
        if (!GREP_VALUE_FLAGS.includes(flag)) continue;
        const attached = arg.slice(position + 1);
        let valueAt = -1;
        if (!attached) {
          index += 1;
          valueAt = index;
        }
        if (flag === 'e' || flag === 'f') patternGiven = true;
        if (flag === 'e' && valueAt >= 0) nonPathArgs.push(valueAt);
        if (flag === 'd' && (attached || args[valueAt]) === 'recurse') {
          recursive = true;
        }
        break;
      }
    } else {
      operands.push(index);
    }
  }
  if (!patternGiven && operands.length > 0) {
    nonPathArgs.push(operands.shift() as number);
  }
  return {
    nonPathArgs,
    walk: recursive
      ? {
          roots: operands.map((index) => args[index]),
          admits: (name) => grepAdmits(filters, name),
        }
      : null,
    reads: recursive,
  };
}

function scanRipgrep(args: string[]): ProgramScan {
  let hidden = false;
  let unrestricted = 0;
  let listsFiles = false;
  let patternGiven = false;
  const globs: Array<{ glob: string; caseInsensitive: boolean }> = [];
  const nonPathArgs: number[] = [];
  const operands: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const width = redirectWidth(arg);
    if (width > 0) {
      index += width - 1;
    } else if (arg === '--') {
      for (let rest = index + 1; rest < args.length; rest += 1) {
        operands.push(rest);
      }
      break;
    } else if (arg.startsWith('--')) {
      const [name, inline] = splitLongOption(arg);
      let valueAt = -1;
      if (inline === undefined && RG_VALUE_OPTIONS.has(name)) {
        index += 1;
        valueAt = index;
      }
      const value = inline ?? args[valueAt];
      if (name === '--hidden') hidden = true;
      if (name === '--no-hidden') hidden = false;
      if (name === '--unrestricted') unrestricted += 1;
      if (name === '--files') listsFiles = true;
      if (name === '--regexp' || name === '--file') patternGiven = true;
      if (name === '--regexp' && valueAt >= 0) nonPathArgs.push(valueAt);
      if ((name === '--glob' || name === '--iglob') && value) {
        globs.push({ glob: value, caseInsensitive: name === '--iglob' });
      }
    } else if (arg.length > 1 && arg.startsWith('-')) {
      for (let position = 1; position < arg.length; position += 1) {
        const flag = arg[position];
        if (flag === '.') hidden = true;
        if (flag === 'u') unrestricted += 1;
        if (!RG_VALUE_FLAGS.includes(flag)) continue;
        const attached = arg.slice(position + 1);
        let valueAt = -1;
        if (!attached) {
          index += 1;
          valueAt = index;
        }
        const value = attached || args[valueAt];
        if (flag === 'e' || flag === 'f') patternGiven = true;
        if (flag === 'e' && valueAt >= 0) nonPathArgs.push(valueAt);
        if (flag === 'g' && value)
          globs.push({ glob: value, caseInsensitive: false });
        break;
      }
    } else {
      operands.push(index);
    }
  }
  if (!patternGiven && !listsFiles && operands.length > 0) {
    nonPathArgs.push(operands.shift() as number);
  }
  const showsHidden = hidden || unrestricted >= 2;
  return {
    nonPathArgs,
    walk: {
      roots: operands.map((index) => args[index]),
      admits: (name) => rgAdmits(globs, showsHidden, name),
    },
    reads: !listsFiles,
  };
}

// find reads file contents only through an -exec/-ok action. Without `-o`,
// every -name/-iname test must pass, so one test that rejects a name keeps
// the action off it.
function scanFind(args: string[]): ProgramScan {
  let index = 0;
  while (index < args.length && /^-(?:[HLP]|O\d*|D)$/.test(args[index])) {
    index += args[index] === '-D' ? 2 : 1;
  }
  const roots: string[] = [];
  for (; index < args.length && !/^[-(!),]/.test(args[index]); index += 1) {
    const width = redirectWidth(args[index]);
    if (width > 0) index += width - 1;
    else roots.push(args[index]);
  }
  const tests: Array<{
    glob: string;
    caseInsensitive: boolean;
    negated: boolean;
  }> = [];
  let disjunction = false;
  let reads = false;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-o' || arg === '-or' || arg === ',') {
      disjunction = true;
    } else if (FIND_EXEC_ACTIONS.has(arg)) {
      const program = path.posix.basename(args[index + 1] ?? '');
      if (!NAME_ONLY_PROGRAMS.has(program)) reads = true;
      while (index + 1 < args.length && !/^[;+]$/.test(args[index + 1])) {
        index += 1;
      }
      index += 1;
    } else if (
      (arg === '-name' || arg === '-iname') &&
      index + 1 < args.length
    ) {
      tests.push({
        glob: args[index + 1],
        caseInsensitive: arg === '-iname',
        negated: NEGATIONS.has(args[index - 1] ?? ''),
      });
      index += 1;
    }
  }
  return {
    nonPathArgs: [],
    walk: {
      roots,
      admits: (name) =>
        disjunction ||
        tests.every(
          (test) =>
            (globMatchesName(test.glob, name, test.caseInsensitive) ??
              !test.negated) !== test.negated,
        ),
    },
    reads,
  };
}

// ls only lists; its walk matters as the file list piped into xargs.
function scanLs(args: string[]): ProgramScan {
  let dotfiles = false;
  const roots: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const width = redirectWidth(arg);
    if (width > 0) index += width - 1;
    else if (arg === '--all' || arg === '--almost-all') dotfiles = true;
    else if (/^-[^-]/.test(arg)) dotfiles ||= /[aA]/.test(arg);
    else if (!arg.startsWith('--')) roots.push(arg);
  }
  return {
    nonPathArgs: [],
    walk: { roots, admits: () => dotfiles },
    reads: false,
  };
}

// The command xargs runs on each batch of input lines; `echo` when none.
export function xargsCommandWords(args: string[]): string[] {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    index += XARGS_VALUE_FLAGS.has(args[index]) ? 2 : 1;
  }
  return index < args.length ? args.slice(index) : ['echo'];
}

function scanXargs(args: string[]): ProgramScan {
  const program = path.posix.basename(xargsCommandWords(args)[0]);
  return {
    nonPathArgs: [],
    walk: null,
    reads: !NAME_ONLY_PROGRAMS.has(program),
  };
}

function scanPrintedText(args: string[]): ProgramScan {
  const nonPathArgs: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const width = redirectWidth(args[index]);
    if (width > 0) index += width - 1;
    else nonPathArgs.push(index);
  }
  return { nonPathArgs, walk: null, reads: false };
}

function scanProgram(program: string, args: string[]): ProgramScan {
  switch (program) {
    case 'grep':
    case 'egrep':
    case 'fgrep':
      return scanGrep(args);
    case 'rg':
      return scanRipgrep(args);
    case 'find':
      return scanFind(args);
    case 'ls':
      return scanLs(args);
    case 'xargs':
      return scanXargs(args);
    case 'echo':
    case 'printf':
      return scanPrintedText(args);
    default:
      return { nonPathArgs: [], walk: null, reads: false };
  }
}

// Values that name files to skip: `--exclude .env`, `--exclude=.env*`, and
// find's `! -name '.env*'`.
function isExclusionValue(words: string[], index: number): boolean {
  return (
    EXCLUDE_ASSIGNMENT_RE.test(words[index]) ||
    EXCLUDE_OPTIONS.has(words[index - 1] ?? '') ||
    (FIND_PATH_TESTS.has(words[index - 1] ?? '') &&
      NEGATIONS.has(words[index - 2] ?? ''))
  );
}

// A word can carry several paths: `<.env`, `--env-file=.env`, `HEAD:.env`,
// curl's `@.env`, `{.env,x}`. A leading `!` marks an exclusion, not a read.
function candidatePaths(word: string): string[] {
  if (URL_RE.test(word)) return [];
  const pieces = new Set([word, ...word.split(/[<>=:@,{}]+/)]);
  return [...pieces]
    .filter((piece) => piece && !/^[!-]/.test(piece))
    .map((piece) => piece.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, '~'));
}

// null when the directory is unknown: after `cd -`, or through a variable or
// command substitution the classifier cannot expand.
function resolvePath(value: string, cwd: Cwd): string | null {
  if (value.includes('$')) return null;
  const expanded = expandUserPath(value).replace(/\\/g, '/');
  if (path.posix.isAbsolute(expanded)) return path.posix.normalize(expanded);
  if (cwd === null) return null;
  return path.posix.normalize(path.posix.join(cwd, expanded));
}

// Absolute hard patterns name directories (`/etc/**`); a walk rooted at one
// of their ancestors reaches them whatever it skips by file name.
function hardPinnedDirs(): Array<{ pattern: string; dir: string }> {
  return HARD_PINNED_PATH_PATTERNS.filter((pattern) =>
    pattern.endsWith('/**'),
  ).map((pattern) => ({
    pattern,
    dir: path.posix.normalize(
      expandUserPath(pattern.slice(0, -3)).replace(/\\/g, '/'),
    ),
  }));
}

function literalPrefix(value: string): string {
  const globAt = value.search(GLOB_CHAR_RE);
  return globAt < 0 ? value : value.slice(0, globAt);
}

// Whether a bash glob segment starting with `stem` can match a name starting
// with `name`: one extends the other, and only a literal `.` matches a dotfile.
function globStemCanMatch(stem: string, name: string): boolean {
  return (
    (name.startsWith(stem) || stem.startsWith(name)) &&
    (stem.startsWith('.') || !name.startsWith('.'))
  );
}

// Bash expands globs before the command runs, so `cat .e*` reads `.env` and
// `cat ~/.s*/id_rsa` reads a key, while `cat *` reaches neither.
function globReachedPatterns(candidate: string): string[] {
  if (!GLOB_CHAR_RE.test(candidate)) return [];
  const reached: string[] = [];
  const name = candidate.slice(candidate.lastIndexOf('/') + 1);
  const nameStem = literalPrefix(name);
  if (nameStem !== name) {
    for (const pattern of PINNED_NAME_SAMPLES.keys()) {
      if (globStemCanMatch(nameStem, literalPrefix(pattern))) {
        reached.push(pattern);
      }
    }
  }
  const absolute = resolvePath(candidate, '');
  if (absolute && path.posix.isAbsolute(absolute)) {
    const prefix = literalPrefix(absolute);
    const parent = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    const stem = prefix.slice(parent.length);
    for (const { pattern, dir } of hardPinnedDirs()) {
      const target = `${dir}/`;
      const nextSegment = target.slice(parent.length).split('/')[0];
      if (
        parent.startsWith(target) ||
        (target.startsWith(parent) && globStemCanMatch(stem, nextSegment))
      ) {
        reached.push(pattern);
      }
    }
  }
  return reached;
}

function pinnedMatches(
  candidate: string,
  cwd: Cwd,
  namesPinnedPath: (candidate: string) => boolean,
): string[] {
  const forms = [candidate];
  const resolved = cwd ? resolvePath(candidate, cwd) : null;
  if (resolved && resolved !== candidate) forms.push(resolved);
  return forms.flatMap((form) =>
    namesPinnedPath(form) ? [form] : globReachedPatterns(form),
  );
}

function walkReaches(walk: Walk, cwd: Cwd): string[] {
  const reaches = [...PINNED_NAME_SAMPLES]
    .filter(([, samples]) => samples.some((sample) => walk.admits(sample)))
    .map(([pattern]) => pattern);
  for (const root of walk.roots.length > 0 ? walk.roots : ['.']) {
    const resolved = resolvePath(root, cwd);
    for (const { pattern, dir } of hardPinnedDirs()) {
      if (
        resolved === null ||
        resolved === '..' ||
        resolved.startsWith('../') ||
        resolved === '/' ||
        resolved === dir ||
        dir.startsWith(`${resolved}/`) ||
        resolved.startsWith(`${dir}/`)
      ) {
        if (!reaches.includes(pattern)) reaches.push(pattern);
      }
    }
  }
  return reaches;
}

// Shell code a command runs itself: `bash -c '...'` or `eval ...`.
function nestedScript(program: string, args: string[]): string | null {
  if (program === 'eval') return args.join(' ');
  if (!SHELL_PROGRAMS.has(program)) return null;
  const flagAt = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
  return flagAt >= 0 ? (args[flagAt + 1] ?? null) : null;
}

interface ScanState {
  namesPinnedPath: (candidate: string) => boolean;
  namedPaths: Set<string>;
  walk: BashPinnedReach['walk'];
}

function scanScript(
  state: ScanState,
  script: string,
  startCwd: Cwd,
  depth: number,
): void {
  let cwd = startCwd;
  // The file list flowing through the current pipe, for xargs.
  let listing: Walk | null = null;

  for (const { words, piped } of splitShellCommands(script)) {
    const start = programIndex(words);
    const program = path.posix.basename(words[start] ?? '');
    const args = words.slice(start + 1);
    const scan = scanProgram(program, args);
    const nonPath = new Set(scan.nonPathArgs.map((index) => index + start + 1));

    for (let index = 0; index < words.length; index += 1) {
      if (nonPath.has(index) || isExclusionValue(words, index)) continue;
      for (const candidate of candidatePaths(words[index])) {
        for (const match of pinnedMatches(
          candidate,
          cwd,
          state.namesPinnedPath,
        )) {
          state.namedPaths.add(match);
        }
      }
    }

    if (!piped) listing = null;
    const reached = program === 'xargs' ? listing : scan.walk;
    if (!state.walk && scan.reads && reached) {
      const reaches = walkReaches(reached, cwd);
      if (reaches.length > 0) state.walk = { program, reaches };
    }
    if (scan.walk) listing = scan.walk;
    else if (program === 'xargs') listing = null;

    const nested =
      depth < MAX_NESTED_SCRIPT_DEPTH ? nestedScript(program, args) : null;
    if (nested) scanScript(state, nested, cwd, depth + 1);

    if (program === 'cd' || program === 'pushd') {
      const target = args.find((arg) => arg === '-' || !arg.startsWith('-'));
      cwd = target === '-' ? null : resolvePath(target ?? '~', cwd);
    } else if (program === 'popd') {
      cwd = null;
    }
  }
}

// `command` should have heredoc bodies removed; pipes and quotes must remain.
export function findBashPinnedReach(
  command: string,
  namesPinnedPath: (candidate: string) => boolean,
): BashPinnedReach {
  const state: ScanState = {
    namesPinnedPath,
    namedPaths: new Set(),
    walk: null,
  };
  scanScript(state, command, '', 0);
  return { namedPaths: [...state.namedPaths], walk: state.walk };
}
