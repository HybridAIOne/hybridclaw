/**
 * Which commands a bash script runs: simple commands split the way bash reads
 * them, plus what `xargs`, `find -exec`, `sh -c`, and `eval` run. Static:
 * variables and substitution results stay unexpanded. NOT a policy: the
 * approval policy and bash-pinned-reach.ts decide what the commands mean.
 */
import path from 'node:path';

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
    for (let index = 0; index < args.length; index += 1) {
      if (!FIND_EXEC_ACTIONS.has(args[index])) continue;
      let end = index + 1;
      while (end < args.length && !/^[;+]$/.test(args[end])) end += 1;
      commands.push(...commandsRun(args.slice(index + 1, end), depth));
      index = end;
    }
  }
  const nested =
    depth < MAX_NESTED_SCRIPT_DEPTH ? nestedScript(program, args) : null;
  if (nested) commands.push(...shellCommandsRun(nested, depth + 1));
  return commands;
}

// Every command a script runs, as words: each simple command, with xargs
// replaced by the command it runs (wrappers stay), plus what `find -exec`,
// `sh -c`, and `eval` run. `script` should have heredoc bodies removed.
export function shellCommandsRun(script: string, depth = 0): string[][] {
  return splitShellCommands(script).flatMap(({ words }) =>
    commandsRun(words, depth),
  );
}
