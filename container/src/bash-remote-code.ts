/**
 * Fetched-code provenance follows curl/wget inputs through scripts and workers.
 * Bounded Python inspection distinguishes data use and retains derived files;
 * Python startup import roots also retain downloaded-module provenance.
 * Parsed output destinations retain origins; opaque copies stay uninspected.
 * Unlike approval policy, this records origins and effects, never permission;
 * hard safety blocks and sandbox boundaries remain independent.
 */
import path from 'node:path';
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
import {
  inspectPythonInline,
  pythonImportRisk,
} from './python-data-inspection.js';
import { resolveCanonicalPath, resolveWorkspacePath } from './runtime-paths.js';

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
}> = [
  {
    program: /^(?:bash|dash|ksh|sh|zsh)$/,
    inline: /^-[a-zA-Z]*c[a-zA-Z]*$/,
    value: /^[-+][a-zA-Z]*o$/,
    stdin: /^-[a-zA-Z]*s/,
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
type CodeSource = (
  | {
      inline: string;
      input?: string;
      python?: true;
      pythonDataOnlyStartup?: boolean;
    }
  | { file: string; opaque?: true }
  | { stdin: true }
  | { substituted: true }
  | { opaque: true }
) & { pythonStartup?: { isolated: boolean; script?: string } };

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

function pythonCodeSource(
  args: string[],
  input: string | undefined,
  dataStartup: boolean,
): CodeSource | null {
  const startup: { isolated: boolean; script?: string } = { isolated: false };
  let options = true;
  const stdin = (): CodeSource =>
    input === undefined
      ? { stdin: true, pythonStartup: startup }
      : input === '' || input.includes('$()')
        ? { substituted: true, pythonStartup: startup }
        : { file: input, pythonStartup: startup };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const width = redirectWidth(arg);
    if (width > 0) {
      index += width - 1;
      continue;
    }
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (!options || !arg.startsWith('-') || arg === '-') {
      return STDIN_PATH_RE.test(arg)
        ? stdin()
        : { file: arg, pythonStartup: { ...startup, script: arg } };
    }
    if (/^--(?:version|help(?:-all|-env|-xoptions)?)$/.test(arg)) return null;
    if (arg.startsWith('--')) return { opaque: true, pythonStartup: startup };
    for (let flagIndex = 1; flagIndex < arg.length; flagIndex += 1) {
      const flag = arg[flagIndex];
      if (flag === 'h' || flag === 'V' || flag === '?') return null;
      if (flag === 'I') startup.isolated = true;
      if (flag === 'c' || flag === 'm') {
        const inline = arg.slice(flagIndex + 1) || (args[index + 1] ?? '');
        return {
          inline,
          ...(input === undefined ? {} : { input }),
          pythonStartup: startup,
          ...(flag === 'c'
            ? { python: true, pythonDataOnlyStartup: dataStartup }
            : {}),
        };
      }
      if (!PYTHON_DATA_FLAGS.has(flag)) dataStartup = false;
      if (flag === 'W' || flag === 'X') {
        if (flagIndex === arg.length - 1) index += 1;
        break;
      }
    }
  }
  return stdin();
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
  if (PYTHON_PROGRAM_RE.test(program))
    return pythonCodeSource(
      args,
      redirectedInput(args),
      !words.slice(0, start).some((word) => /^PYTHON[A-Z_]*=/.test(word)),
    );
  const interpreter = INTERPRETERS.find((entry) => entry.program.test(program));
  if (!interpreter) {
    // A path as the program runs that file: `./install.sh`, `/tmp/foo`.
    const programWord = words[start] ?? '';
    return programWord.includes('/') ? { file: programWord } : null;
  }
  const input = redirectedInput(args);
  let readsStdin = false;
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
        };
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
  // Codex, 2026-11-08: at most four bounded parser processes per
  // tool call, shared by nested shells. Further candidates stay conservative.
  parseBudget = { remaining: 4 },
): {
  saved: string[];
  runs: boolean;
  uncertain: boolean;
  pathHints: string[];
  writeIntent: boolean;
} {
  const saved: string[] = [];
  let runs = false;
  let uncertain = false;
  const pathHints: string[] = [];
  let writeIntent = false;
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
  const rememberWrites = (targets: Iterable<string>, cwd: Cwd): void => {
    for (const target of targets) {
      const resolved = resolvePath(target, cwd);
      const origin = resolved ?? UNKNOWN_FETCH_LOCATION;
      if (!saved.includes(origin)) saved.push(origin);
      unknownLocation ||= resolved === null;
    }
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
    let dataFetched = false;
    if (FETCH_PROGRAMS.has(program)) {
      rememberWrites(commandWriteTargets(words), cwd);
    }
    const programPath = words[command.start] ?? '';
    if (programPath.includes('/') && isSaved(programPath, cwd)) runs = true;
    const source = codeSource(command);
    const inspection =
      source &&
      'inline' in source &&
      source.python &&
      !source.inline.includes('$()') &&
      parseBudget.remaining-- > 0
        ? inspectPythonInline(source.inline, [...savedBefore, ...saved], cwd)
        : null;
    if (source?.pythonStartup) {
      const startup = source.pythonStartup;
      const script =
        startup.script === undefined
          ? undefined
          : resolvePath(startup.script, cwd);
      const importRoot =
        script === undefined
          ? cwd
          : script === null
            ? null
            : path.dirname(
                resolveCanonicalPath(resolveWorkspacePath(script) ?? script),
              );
      if (
        pythonImportRisk(
          [...savedBefore, ...saved],
          importRoot,
          startup.isolated &&
            (!('inline' in source) || !source.python || inspection !== null),
          inspection,
        )
      ) {
        runs = true;
        uncertain = true;
      }
    }
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
      const data = source.pythonDataOnlyStartup ? inspection?.data : null;
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
      } else if (data) {
        pathHints.push(...data.pathHints);
        writeIntent ||= data.writes.length > 0;
        dataFetched =
          data.reads.some((file) => isSaved(file, cwd)) ||
          (piped && pipelineFetched) ||
          (source.input !== undefined && isSaved(source.input, cwd));
        if (dataFetched) rememberWrites(data.writes, cwd);
      } else if (depth < MAX_NESTED_SCRIPT_DEPTH) {
        const innerCommands = scriptCommands(source.inline, cwd);
        if (
          source.python &&
          ((piped && pipelineFetched) ||
            (source.input !== undefined && isSaved(source.input, cwd)) ||
            inspection?.literals.some((text) => isSaved(text, cwd)) ||
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
        pathHints.push(...nested.pathHints);
        writeIntent ||= nested.writeIntent;
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
    const fetchedInput: boolean =
      dataFetched ||
      (piped && pipelineFetched) ||
      args.some((arg) => isSaved(arg, cwd));
    if (fetchedInput) rememberWrites(commandWriteTargets(words), cwd);
    pipelineFetched = fetchedInput || FETCH_PROGRAMS.has(program);
    pipelineOpaque =
      (piped && pipelineOpaque) || Boolean(source && 'opaque' in source);
  }
  return { saved, runs, uncertain, pathHints, writeIntent };
}
