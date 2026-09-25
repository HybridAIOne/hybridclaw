/**
 * What a bash script does, read statically: the commands it runs (including
 * what `xargs`, `find -exec`, `sh -c`, and `eval` run), the paths they write
 * or delete, and the directory each runs in after `cd`. Variables and
 * substitution results stay unknown. NOT a policy: the approval policy and
 * bash-pinned-reach.ts decide what needs approval.
 */
import path from 'node:path';
import { expandUserPath } from './runtime-paths.js';

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
const REDIRECT_RE = /^(?:\d+|&)?[<>]/;
const BARE_REDIRECT_RE = /^(?:\d+|&)?[<>]+&?$/;
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
export const FIND_EXEC_ACTIONS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
]);
export const MAX_NESTED_SCRIPT_DEPTH = 3;
// Text fallback beside deletesFiles(): catches `rm -…` inside another
// command's arguments, such as `docker exec box rm -rf /data`. `git rm` is left
// to deletesFiles(), since `git rm --cached` keeps the files.
export const DELETE_RE =
  /(?<!\bgit\s+)\brm\s+-[^\n;|&]*\b|\bfind\b[^\n]*\s-delete\b/i;
const RG_PROGRAM_OPTION_RE = /^--(?:pre|hostname-bin)(?:=|$)/;
const FIND_WRITE_ACTIONS = new Set(['-fls', '-fprint', '-fprint0', '-fprintf']);
// Programs that write every path operand they are given.
const OPERAND_WRITERS = new Set(['chmod', 'chown', 'mkdir', 'tee', 'touch']);

interface ShellCommand {
  words: string[];
  // Reads the previous command's output through `|`.
  piped: boolean;
}

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
      // `<` and `>` end a word unless it is a descriptor prefix (`2>`, `&>`)
      // or more operator (`>>`), so `echo x>out` redirects like bash does.
      if (
        (char === '<' || char === '>') &&
        inWord &&
        !/^(?:\d+|&)?[<>&]*$/.test(word)
      ) {
        endWord();
      }
      word += char;
      inWord = true;
    }
  }
  while (frames.length > 0) closeSubstitution();
  endCommand();
  return commands;
}

// The program a simple command runs (lowercased base name), past assignments,
// keywords, and wrappers such as `timeout 5`; `command -v rm` only looks rm up.
export function commandProgram(words: string[]): {
  start: number;
  program: string;
  args: string[];
} {
  let start = 0;
  let wrapped = false;
  for (; start < words.length; start += 1) {
    const word = words[start];
    if (word === 'command' && /^-[vV]$/.test(words[start + 1] ?? '')) {
      return { start: words.length, program: '', args: [] };
    }
    if (COMMAND_PREFIX_WORDS.has(word)) wrapped = true;
    else if (!ASSIGNMENT_RE.test(word) && !(wrapped && /^[-\d]/.test(word))) {
      break;
    }
  }
  return {
    start,
    program: path.posix.basename(words[start] ?? '').toLowerCase(),
    args: words.slice(start + 1),
  };
}

// Words a redirection spans: `>out` and `2>&1` are one, a bare `>` also takes
// the next word as its target.
export function redirectWidth(word: string): number {
  if (!REDIRECT_RE.test(word)) return 0;
  return BARE_REDIRECT_RE.test(word) ? 2 : 1;
}

// find's starting points: the words before its first expression token, past
// the -H/-L/-P/-O/-D options. None means the current directory.
export function findStartingPoints(args: string[]): {
  roots: string[];
  expressionStart: number;
} {
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
  return { roots, expressionStart: index };
}

// The command xargs runs on each batch of input lines; `echo` when none.
export function xargsCommandWords(args: string[]): string[] {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    index += XARGS_VALUE_FLAGS.has(args[index]) ? 2 : 1;
  }
  return index < args.length ? args.slice(index) : ['echo'];
}

// Shell code a command runs itself: `bash -c '...'` or `eval ...`.
export function nestedScript(program: string, args: string[]): string | null {
  if (program === 'eval') return args.join(' ');
  if (!SHELL_PROGRAMS.has(program)) return null;
  const flagAt = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
  return flagAt >= 0 ? (args[flagAt + 1] ?? null) : null;
}

// The commands find's -exec, -execdir, -ok, and -okdir actions run, each up
// to its `;` or `+`.
function findExecCommands(args: string[]): string[][] {
  const commands: string[][] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (!FIND_EXEC_ACTIONS.has(args[index])) continue;
    let end = index + 1;
    while (end < args.length && !/^[;+]$/.test(args[end])) end += 1;
    commands.push(args.slice(index + 1, end));
    index = end;
  }
  return commands;
}

function commandsRun(words: string[], depth: number): string[][] {
  const { start, program, args } = commandProgram(words);
  if (program === 'xargs') {
    return commandsRun(
      [...words.slice(0, start), ...xargsCommandWords(args)],
      depth,
    );
  }
  const commands = [words];
  if (program === 'find') {
    for (const exec of findExecCommands(args)) {
      commands.push(...commandsRun(exec, depth));
    }
  }
  const nested =
    depth < MAX_NESTED_SCRIPT_DEPTH ? nestedScript(program, args) : null;
  if (nested) {
    commands.push(...shellCommandsRun(scriptCommands(nested), depth + 1));
  }
  return commands;
}

// Every command a script runs, as words: each simple command, with xargs
// replaced by the command it runs (wrappers stay), plus what `find -exec`,
// `sh -c`, and `eval` run.
export function shellCommandsRun(
  commands: ScriptCommand[],
  depth = 0,
): string[][] {
  return commands.flatMap(({ words }) => commandsRun(words, depth));
}

// '' is the starting directory (the workspace); null is unknown (`cd -`).
export type Cwd = string | null;

// `$HOME/x` and `${HOME}/x` name the same path as `~/x`.
export const HOME_VARIABLE_RE = /^\$(?:HOME|\{HOME\})(?=\/|$)/;

// null when the path is unknown: after `cd -`, or through another variable or
// a command substitution the classifier cannot expand. Relative results stay
// relative to the starting directory.
export function resolvePath(value: string, cwd: Cwd): string | null {
  const withHome = value.replace(HOME_VARIABLE_RE, '~');
  if (withHome.includes('$')) return null;
  const expanded = expandUserPath(withHome).replace(/\\/g, '/');
  if (path.posix.isAbsolute(expanded)) return path.posix.normalize(expanded);
  if (cwd === null) return null;
  return path.posix.normalize(path.posix.join(cwd, expanded));
}

// The directory a command leaves the script in: `cd`/`pushd` move it (bare
// `cd` goes home), `cd -` and `popd` make it unknown.
export function directoryAfter(cwd: Cwd, program: string, args: string[]): Cwd {
  if (program === 'popd') return null;
  if (program !== 'cd' && program !== 'pushd') return cwd;
  const target = args.find((arg) => arg === '-' || !arg.startsWith('-'));
  return target === '-' ? null : resolvePath(target ?? '~', cwd);
}

export interface ScriptCommand {
  words: string[];
  start: number;
  program: string;
  args: string[];
  // Reads the previous command's output through `|`.
  piped: boolean;
  // Its output feeds the next command.
  pipesOut: boolean;
  // The directory it runs in.
  cwd: Cwd;
}

// A script parsed once for every check: each simple command with its program
// and the directory it runs in. `script` should have heredoc bodies removed.
export function scriptCommands(
  script: string,
  startCwd: Cwd = '',
): ScriptCommand[] {
  const commands = splitShellCommands(script);
  let cwd = startCwd;
  return commands.map(({ words, piped }, position) => {
    const { start, program, args } = commandProgram(words);
    const pipesOut = commands[position + 1]?.piped === true;
    const command = { words, start, program, args, piped, pipesOut, cwd };
    cwd = directoryAfter(cwd, program, args);
    return command;
  });
}

// A command's operands: words that are neither options (until `--`) nor
// redirections.
function commandOperands(args: string[]): string[] {
  const operands: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const width = redirectWidth(arg);
    if (width > 0) {
      index += width - 1;
    } else if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (optionsEnded || !arg.startsWith('-')) {
      operands.push(arg);
    }
  }
  return operands;
}

// git's global options come before the subcommand; -C and -c take a value.
function gitSubcommandIndex(args: string[]): number {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    index += /^-[Cc]$/.test(args[index]) ? 2 : 1;
  }
  return index;
}

// rm and unlink delete their operands, `find -delete` what it matches, and
// `git rm` its paths unless --cached keeps them on disk. rmdir stays out: it
// only removes empty directories.
export function deletesFiles(words: string[]): boolean {
  const { program, args } = commandProgram(words);
  if (program === 'rm' || program === 'unlink') return true;
  if (program === 'find') return args.includes('-delete');
  return (
    program === 'git' &&
    args[gitSubcommandIndex(args)] === 'rm' &&
    !args.includes('--cached')
  );
}

// Paths resolved against `cwd`; `{}` stands for each file find reaches under
// its starting points. null when a variable or an unknown `cd` hides one.
function resolveTargets(targets: string[], cwd: Cwd): string[] | null {
  const resolved: string[] = [];
  for (const target of targets) {
    if (target === '{}') continue;
    const resolvedTarget = resolvePath(target, cwd);
    if (resolvedTarget === null) return null;
    resolved.push(resolvedTarget);
  }
  return resolved;
}

// What one command deletes, resolved against the directory it runs in:
// rm/unlink/`git rm` operands, and the starting points of `find -delete` or
// of a `find -exec` that deletes. null when the targets are unknown: `xargs
// rm` reads them from stdin, a variable or unknown `cd` hides them, and the
// DELETE_RE fallback only sees `rm -…` somewhere in the text.
function commandDeletionTargets(
  words: string[],
  cwd: Cwd,
  depth: number,
): string[] | null {
  const { program, args } = commandProgram(words);
  if (program === 'rm' || program === 'unlink') {
    const operands = commandOperands(args);
    return operands.length > 0 ? resolveTargets(operands, cwd) : null;
  }
  if (program === 'git' && deletesFiles(words)) {
    if (args.some((arg) => arg.startsWith('--pathspec-from-file'))) {
      return null;
    }
    const pathspecs = commandOperands(args.slice(gitSubcommandIndex(args) + 1));
    return pathspecs.length > 0 ? resolveTargets(pathspecs, cwd) : null;
  }
  if (program === 'find') {
    const targets: string[] = [];
    let deletes = args.includes('-delete');
    for (const exec of findExecCommands(args)) {
      const execTargets = commandDeletionTargets(exec, cwd, depth);
      if (execTargets === null) return null;
      if (execTargets.length > 0 || deletesFiles(exec)) deletes = true;
      targets.push(...execTargets);
    }
    if (!deletes) return targets;
    const { roots } = findStartingPoints(args);
    const resolvedRoots = resolveTargets(roots.length > 0 ? roots : ['.'], cwd);
    return resolvedRoots === null ? null : [...targets, ...resolvedRoots];
  }
  if (program === 'xargs') {
    const inner = xargsCommandWords(args);
    const innerTargets = commandDeletionTargets(inner, cwd, depth);
    const deletes =
      innerTargets === null || innerTargets.length > 0 || deletesFiles(inner);
    return deletes ? null : [];
  }
  const nested =
    depth < MAX_NESTED_SCRIPT_DEPTH ? nestedScript(program, args) : null;
  if (nested !== null) {
    return deletionTargets(scriptCommands(nested, cwd), depth + 1);
  }
  return DELETE_RE.test(words.join(' ')) ? null : [];
}

export function deletionTargets(
  commands: ScriptCommand[],
  depth = 0,
): string[] | null {
  const targets: string[] = [];
  for (const { words, cwd } of commands) {
    const found = commandDeletionTargets(words, cwd, depth);
    if (found === null) return null;
    targets.push(...found);
  }
  return targets;
}

// ripgrep runs `--pre` and `--hostname-bin` values as programs: `rg --pre
// python3 KEY` executes python3 on every file it searches.
export function runsProgramOption(words: string[]): boolean {
  const { program, args } = commandProgram(words);
  if (program !== 'rg') return false;
  const optionsEnd = args.indexOf('--');
  return args
    .slice(0, optionsEnd < 0 ? args.length : optionsEnd)
    .some((arg) => RG_PROGRAM_OPTION_RE.test(arg));
}

// Files a command writes through an option instead of a redirect: git's
// `--output FILE` and find's -fprint/-fprint0/-fprintf/-fls actions.
export function optionWriteTargets(words: string[]): string[] {
  const { program, args } = commandProgram(words);
  if (program !== 'git' && program !== 'find') return [];
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (program === 'git') {
      if (arg === '--') break;
      if (arg.startsWith('--output=')) {
        targets.push(arg.slice('--output='.length));
      } else if (arg === '--output') {
        targets.push(args[index + 1] ?? '');
        index += 1;
      }
    } else if (FIND_EXEC_ACTIONS.has(arg)) {
      while (index + 1 < args.length && !/^[;+]$/.test(args[index + 1])) {
        index += 1;
      }
    } else if (FIND_WRITE_ACTIONS.has(arg)) {
      targets.push(args[index + 1] ?? '');
      index += 1;
    }
  }
  return targets;
}

// Files an output redirection writes: `>f`, `>> f`, `2>f`, `&>f`, `>& f`.
// `>&2` and `2>&1` duplicate a descriptor instead.
function redirectTargets(words: string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const match = /^(?:\d+|&)?>(>|&)?(.*)$/.exec(words[index]);
    if (!match) continue;
    let target = match[2];
    if (!target) {
      index += 1;
      target = words[index] ?? '';
    }
    if (match[1] === '&' && /^(?:\d+|-)$/.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

// cp and mv write into `-t DIR` when given, else into their last operand.
function copyDestination(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-t' || arg === '--target-directory') return args[index + 1];
    if (arg.startsWith('--target-directory=')) {
      return arg.slice('--target-directory='.length);
    }
    if (/^-t./.test(arg)) return arg.slice(2);
  }
  return commandOperands(args).at(-1);
}

// What one command writes, as written: redirect targets, `-o`/`--out` values,
// option writes, the operands of tee/mkdir/touch/chmod/chown, cp/mv
// destinations, and what xargs or `find -exec` runs.
function commandWriteTargets(words: string[]): string[] {
  const { program, args } = commandProgram(words);
  const targets = [...redirectTargets(words), ...optionWriteTargets(words)];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    if (/^(?:-o|--out)$/.test(args[index]) && !value?.startsWith('-')) {
      targets.push(value ?? '');
    }
  }
  if (OPERAND_WRITERS.has(program)) targets.push(...commandOperands(args));
  if (program === 'cp' || program === 'mv') {
    targets.push(copyDestination(args) ?? '');
  }
  if (program === 'xargs') {
    targets.push(...commandWriteTargets(xargsCommandWords(args)));
  }
  if (program === 'find') {
    for (const exec of findExecCommands(args)) {
      targets.push(...commandWriteTargets(exec));
    }
  }
  return targets.filter(Boolean);
}

// Every path a script writes, resolved against the directory each command
// runs in (bash starts in the workspace, and `cd` moves it). Relative results
// stay relative to that start, so `../out.txt` climbs out; targets behind a
// variable or an unknown `cd` are left out.
export function writeTargets(commands: ScriptCommand[], depth = 0): string[] {
  const targets: string[] = [];
  for (const { words, program, args, cwd } of commands) {
    for (const target of commandWriteTargets(words)) {
      const resolved = resolvePath(target, cwd);
      if (resolved !== null) targets.push(resolved);
    }
    const nested =
      depth < MAX_NESTED_SCRIPT_DEPTH ? nestedScript(program, args) : null;
    if (nested !== null) {
      targets.push(...writeTargets(scriptCommands(nested, cwd), depth + 1));
    }
  }
  return targets;
}
