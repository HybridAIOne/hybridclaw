/**
 * Fetched-code detection: does a bash script run code that curl or wget
 * brought in? It covers a fetch piped into an interpreter (`curl … | sh`) or
 * substituted into one (`sh -c "$(curl …)"`, `bash <(curl …)`), and running a
 * file a fetch saved, earlier in the same script or (through the caller's
 * `savedBefore`) in an earlier call.
 *
 * NOT a policy: the approval policy decides the tier, and tools.ts still
 * hard-blocks `curl | sh`. Copies of a saved file (`cp`, `tar x`) and code the
 * model re-types through the write tool are not followed.
 */
import {
  type Cwd,
  commandWriteTargets,
  MAX_NESTED_SCRIPT_DEPTH,
  redirectWidth,
  resolvePath,
  type ScriptCommand,
  scriptCommands,
} from './bash-commands.js';

const FETCH_PROGRAMS = new Set(['curl', 'wget']);
// Interpreters, with the options whose value is the program text or a module
// (so neither a file operand nor stdin runs) and the options that take some
// other value; shells also run stdin under `-s` (`sh -s -- args`). Letters
// cluster (`bash -eo pipefail`, `python3 -Bc`, `perl -ne`), and a value-taking
// letter ends its cluster, so these match it as the cluster's last letter.
const INTERPRETERS: Array<{
  program: RegExp;
  inline?: RegExp;
  value?: RegExp;
  stdin?: RegExp;
}> = [
  {
    program: /^(?:bash|dash|ksh|sh|zsh)$/,
    inline: /^-[a-zA-Z]*c[a-zA-Z]*$/,
    value: /^[-+][a-zA-Z]*o$/,
    stdin: /^-[a-zA-Z]*s/,
  },
  {
    program: /^python\d*(?:\.\d+)?$/,
    inline: /^-[a-zA-Z]*[cm]$/,
    value: /^-[a-zA-Z]*[WX]$/,
  },
  {
    program: /^(?:node|nodejs)$/,
    inline: /^(?:-[ep]|--eval|--print)$/,
    value: /^(?:-r|--require|--import)$/,
  },
  { program: /^(?:perl|ruby)$/, inline: /^-[a-zA-Z]*[eE]$/ },
  { program: /^php$/, inline: /^-r$/ },
  { program: /^(?:source|\.)$/ },
];
const STDIN_PATH_RE = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

// Where a command takes code from. `substituted` is a `$(…)`, `<(…)`, or
// `<<<` result the parser cannot see into.
type CodeSource =
  | { inline: string }
  | { file: string }
  | { stdin: true }
  | { substituted: true };

function codeSource({
  words,
  start,
  program,
  args,
}: ScriptCommand): CodeSource | null {
  if (program === 'eval') return { inline: args.join(' ') };
  const interpreter = INTERPRETERS.find((entry) => entry.program.test(program));
  if (!interpreter) {
    // A path as the program runs that file: `./install.sh`, `/tmp/foo`.
    const programWord = words[start] ?? '';
    return programWord.includes('/') ? { file: programWord } : null;
  }
  let input: string | undefined;
  let readsStdin = false;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const width = redirectWidth(arg);
    if (width > 0) {
      // `< f`, `<f`, `<<< "$(…)"`; the parser leaves `<(` as a bare `<`.
      const target =
        width === 2 ? (args[index + 1] ?? '') : arg.replace(/^\d*<+/, '');
      if (/^0?</.test(arg)) input = target;
      index += width - 1;
    } else if (operands.length === 0 && /^[-+]./.test(arg)) {
      if (interpreter.inline?.test(arg)) {
        return { inline: args[index + 1] ?? '' };
      }
      if (interpreter.value?.test(arg)) index += 1;
      if (interpreter.stdin?.test(arg)) readsStdin = true;
    } else {
      operands.push(arg);
    }
  }
  if (!readsStdin && operands.length > 0 && !STDIN_PATH_RE.test(operands[0])) {
    return { file: operands[0] };
  }
  if (input === undefined) return { stdin: true };
  return input === '' || input.includes('$()')
    ? { substituted: true }
    : { file: input };
}

export function findFetchedCode(
  commands: ScriptCommand[],
  savedBefore: ReadonlySet<string>,
  depth = 0,
): { saved: string[]; runs: boolean } {
  const saved: string[] = [];
  let runs = false;
  // Whether the current pipeline carries fetched bytes: a fetch, or a command
  // naming a saved file (`cat install.sh | sh`).
  let pipelineFetched = false;
  const isSaved = (word: string, cwd: Cwd): boolean => {
    const resolved = resolvePath(word, cwd);
    return (
      resolved !== null &&
      (savedBefore.has(resolved) || saved.includes(resolved))
    );
  };
  // Whether a substitution result can hold fetched bytes; `$(…)` bodies are
  // commands of their own, so this looks at the whole script from where it
  // starts.
  const startCwd = commands[0]?.cwd ?? '';
  const substitutesFetched = commands.some(
    ({ words, program }) =>
      FETCH_PROGRAMS.has(program) ||
      words.some((word) => isSaved(word, startCwd)),
  );
  for (const command of commands) {
    const { words, program, args, piped, cwd } = command;
    if (FETCH_PROGRAMS.has(program)) {
      for (const target of commandWriteTargets(words)) {
        const resolved = resolvePath(target, cwd);
        if (resolved !== null) saved.push(resolved);
      }
    }
    const source = codeSource(command);
    if (!source) {
      // Not running code.
    } else if ('inline' in source) {
      if (source.inline.includes('$()')) {
        runs ||= substitutesFetched;
      } else if (depth < MAX_NESTED_SCRIPT_DEPTH) {
        const nested = findFetchedCode(
          scriptCommands(source.inline, cwd),
          new Set([...savedBefore, ...saved]),
          depth + 1,
        );
        saved.push(...nested.saved);
        runs ||= nested.runs;
      }
    } else if ('substituted' in source) {
      runs ||= substitutesFetched;
    } else if ('stdin' in source) {
      runs ||= piped && pipelineFetched;
    } else {
      runs ||= isSaved(source.file, cwd);
    }
    pipelineFetched =
      (piped && pipelineFetched) ||
      FETCH_PROGRAMS.has(program) ||
      args.some((arg) => isSaved(arg, cwd));
  }
  return { saved, runs };
}
