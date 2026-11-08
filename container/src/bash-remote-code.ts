/**
 * Fetched-code detection: does a bash script run code that curl or wget
 * brought in? It covers a fetch piped into an interpreter (`curl … | sh`) or
 * substituted into one (`sh -c "$(curl …)"`, `bash <(curl …)`), and running a
 * file a fetch saved, earlier in the same script or (through the caller's
 * `savedBefore`) in an earlier call.
 *
 * A bounded, non-executing Python syntax check recognizes data-only consumers.
 * Unsupported interpreter bodies keep conservative provenance inspection.
 * Opaque wrappers retain uncertainty; hidden download locations are recorded
 * across workers so later file execution still needs provenance review.
 * NOT a policy: the approval policy decides the tier, and tools.ts still
 * hard-blocks `curl | sh`. Copies of a saved file (`cp`, `tar x`) and code the
 * model re-types through the write tool are not followed.
 */
import {
  type Cwd,
  commandProgram,
  commandWriteTargets,
  MAX_NESTED_SCRIPT_DEPTH,
  PYTHON_PROGRAM_RE,
  redirectWidth,
  resolvePath,
  type ScriptCommand,
  scriptCommands,
  splitShellCommands,
} from './bash-commands.js';
import { isReadOnlyPythonInline } from './python-data-reader.js';

const FETCH_PROGRAMS = new Set(['curl', 'wget']);
// NUL cannot be a filesystem path. Persist this provenance marker when a
// wrapper hides download locations, so worker replacement cannot erase it.
const UNKNOWN_FETCH_LOCATION = '\0unknown-fetch-location';
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
  python?: true;
}> = [
  {
    program: /^(?:bash|dash|ksh|sh|zsh)$/,
    inline: /^-[a-zA-Z]*c[a-zA-Z]*$/,
    value: /^[-+][a-zA-Z]*o$/,
    stdin: /^-[a-zA-Z]*s/,
  },
  {
    program: PYTHON_PROGRAM_RE,
    python: true,
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
// Codex, 2026-11-08: only ordinary execution flags qualify a
// Python data reader; interactive and import-customizing startup stays opaque.
const PYTHON_DATA_FLAGS = new Set('bBdEIOqRsSu');
const STDIN_PATH_RE = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

// Where a command takes code from. `substituted` is a `$(…)`, `<(…)`, or
// `<<<` result the parser cannot see into. `opaque` is a wrapper whose argv or
// working directory cannot be interpreted; its executable path stays visible.
type CodeSource =
  | {
      inline: string;
      input?: string;
      python?: true;
      pythonDataOnlyStartup?: boolean;
    }
  | { file: string; opaque?: true }
  | { stdin: true }
  | { substituted: true }
  | { opaque: true };

function redirectedInput(args: string[]): string | undefined {
  let input: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const width = redirectWidth(arg);
    if (width === 0) continue;
    // Redirections can follow inline program text and use attached targets.
    if (/^0?</.test(arg)) {
      input = width === 2 ? (args[index + 1] ?? '') : arg.replace(/^\d*<+/, '');
    }
    index += width - 1;
  }
  return input;
}

export function codeSource({
  words,
  start,
  program,
  args,
  unresolvedPrefix,
}: Pick<
  ScriptCommand,
  'words' | 'start' | 'program' | 'args' | 'unresolvedPrefix'
>): CodeSource | null {
  if (unresolvedPrefix) {
    const programWord = words[start] ?? '';
    return programWord.includes('/')
      ? { file: programWord, opaque: true }
      : { opaque: true };
  }
  if (program === 'eval') return { inline: args.join(' ') };
  const interpreter = INTERPRETERS.find((entry) => entry.program.test(program));
  if (!interpreter) {
    // A path as the program runs that file: `./install.sh`, `/tmp/foo`.
    const programWord = words[start] ?? '';
    return programWord.includes('/') ? { file: programWord } : null;
  }
  const input = redirectedInput(args);
  let readsStdin = false;
  let pythonDataOnlyStartup = !words
    .slice(0, start)
    .some((word) => /^PYTHON[A-Z_]*=/.test(word));
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const width = redirectWidth(arg);
    if (width > 0) {
      index += width - 1;
    } else if (operands.length === 0 && /^[-+]./.test(arg)) {
      if (interpreter.inline?.test(arg)) {
        return {
          inline: args[index + 1] ?? '',
          ...(input === undefined ? {} : { input }),
          ...(interpreter.python && arg.endsWith('c')
            ? {
                python: true as const,
                pythonDataOnlyStartup:
                  pythonDataOnlyStartup &&
                  [...arg.slice(1, -1)].every((flag) =>
                    PYTHON_DATA_FLAGS.has(flag),
                  ),
              }
            : {}),
        };
      }
      if (
        interpreter.python &&
        ![...arg.slice(1)].every((flag) => PYTHON_DATA_FLAGS.has(flag))
      )
        pythonDataOnlyStartup = false;
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
  // Codex, 2026-11-08: at most four bounded parser processes per
  // tool call, shared by nested shells. Further candidates stay conservative.
  parseBudget = { remaining: 4 },
): { saved: string[]; runs: boolean; uncertain: boolean } {
  const saved: string[] = [];
  let runs = false;
  let uncertain = false;
  let unknownLocation = savedBefore.has(UNKNOWN_FETCH_LOCATION);
  // Whether the current pipeline carries fetched bytes: a fetch, or a command
  // naming a saved file (`cat install.sh | sh`).
  let pipelineFetched = false;
  let pipelineOpaque = false;
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
    const programPath = words[command.start] ?? '';
    if (programPath.includes('/') && isSaved(programPath, cwd)) runs = true;
    const source = codeSource(command);
    if (
      source &&
      'opaque' in source &&
      words.some((word) =>
        splitShellCommands(word).some((part) =>
          FETCH_PROGRAMS.has(commandProgram(part.words).program),
        ),
      )
    ) {
      if (!unknownLocation) saved.push(UNKNOWN_FETCH_LOCATION);
      unknownLocation = true;
    }
    if (!source) {
      // Not running code.
    } else if ('opaque' in source) {
      // A wrapper may reinterpret argv or change the base of a saved path.
      // Do not assert a data-only consumer when fetched input is available.
      if (
        unknownLocation ||
        substitutesFetched ||
        savedBefore.size > 0 ||
        saved.length > 0 ||
        (piped && pipelineFetched)
      ) {
        runs = true;
        uncertain = true;
      }
    } else if ('inline' in source) {
      if (
        source.python &&
        !source.pythonDataOnlyStartup &&
        (savedBefore.size > 0 || saved.length > 0 || (piped && pipelineFetched))
      ) {
        runs = true;
        uncertain = true;
      }
      if (source.inline.includes('$()')) {
        runs ||= substitutesFetched || unknownLocation;
        uncertain ||= unknownLocation;
      } else if (
        source.pythonDataOnlyStartup &&
        parseBudget.remaining-- > 0 &&
        isReadOnlyPythonInline(source.inline, [...savedBefore, ...saved])
      ) {
        // Python data paths are operands, not shell executables.
      } else if (depth < MAX_NESTED_SCRIPT_DEPTH) {
        const innerCommands = scriptCommands(source.inline, cwd);
        if (
          source.python &&
          ((piped && pipelineFetched) ||
            (source.input !== undefined && isSaved(source.input, cwd)) ||
            words.some((word) => isSaved(word, cwd)) ||
            innerCommands.some(({ words }) =>
              words.some((word) => isSaved(word, cwd)),
            ))
        ) {
          // Unsupported bodies can consume fetched operands or stdin. File
          // mentions include relative paths; this is uncertainty, not proof.
          runs = true;
          uncertain = true;
        }
        const nested = findFetchedCode(
          innerCommands,
          new Set([...savedBefore, ...saved]),
          depth + 1,
          parseBudget,
        );
        saved.push(...nested.saved);
        unknownLocation ||= nested.saved.includes(UNKNOWN_FETCH_LOCATION);
        runs ||= nested.runs;
        uncertain ||=
          nested.uncertain || (source.python === true && nested.runs);
      }
    } else if ('substituted' in source) {
      runs ||= substitutesFetched || unknownLocation;
      uncertain ||= unknownLocation;
    } else if ('stdin' in source) {
      runs ||=
        unknownLocation || (piped && (pipelineFetched || pipelineOpaque));
      uncertain ||= unknownLocation || (piped && pipelineOpaque);
    } else {
      runs ||= unknownLocation || isSaved(source.file, cwd);
      uncertain ||= unknownLocation;
    }
    pipelineFetched =
      (piped && pipelineFetched) ||
      FETCH_PROGRAMS.has(program) ||
      args.some((arg) => isSaved(arg, cwd));
    pipelineOpaque =
      (piped && pipelineOpaque) || Boolean(source && 'opaque' in source);
  }
  return { saved, runs, uncertain };
}
