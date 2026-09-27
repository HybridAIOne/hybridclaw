/**
 * Paths the workspace fence checks for one bash line. Every write target the
 * parser resolves counts. When none is absolute and some command writes in
 * ways the parser does not follow (`rm`, `sed -i`, installers, interpreters,
 * unknown programs), every path the line names from the root or home counts
 * too, quoted or not, except text a command reads as code or a pattern and
 * files the line only runs. Reading from outside is never a write.
 *
 * NOT the decision: approval-policy.ts drops workspace, scratch, and
 * /dev/null paths. What each command writes is bash-commands.ts.
 */
import path from 'node:path';
import {
  type Cwd,
  deletesFiles,
  MAX_NESTED_SCRIPT_DEPTH,
  nestedScript,
  OPERAND_WRITERS,
  redirectWidth,
  resolvePath,
  type ScriptCommand,
  scriptCommands,
  shellCommandsRun,
  writeTargets,
} from './bash-commands.js';
import { NAME_ONLY_PROGRAMS, nonPathWords } from './bash-pinned-reach.js';
import { codeSource } from './bash-remote-code.js';

// Programs whose writes writeTargets() resolves in full unless an operand
// hides behind a variable or substitution. mv is not one: it removes its
// sources.
const PARSED_WRITERS = new Set([...OPERAND_WRITERS, 'cd', 'cp', 'pushd']);
const SED_PROGRAMS = new Set(['gsed', 'sed']);
const AWK_PROGRAMS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
// `/x`, `~`, `~/x`, `$HOME/x`, and `${HOME}/x`.
const ROOTED_PATH_RE = /^(?:\/|~(?:\/|$)|\$(?:HOME|\{HOME\})(?:\/|$))/;
const LONG_OPTION_VALUE_RE = /^--[^=]+=(.*)$/;
// BSD `sed -i ''` and `sed -i .bak` take the backup suffix as its own word.
const SED_SUFFIX_RE = /^(?:|\.[\w.~-]*)$/;

// Whether writeTargets() sees everything a command writes. Read-only commands
// (as the green tier judges them) and programs that print names or text write
// only through redirects and write options, which the parser follows. What
// xargs, `find -exec`, or `sh -c` runs counts as the command's own.
function writesParsed(
  command: ScriptCommand,
  isReadOnly: (words: string[]) => boolean,
): boolean {
  const run = shellCommandsRun([command]);
  if (run.every((words) => isReadOnly(words) && !deletesFiles(words))) {
    return true;
  }
  if (run.length > 1) return false;
  if (NAME_ONLY_PROGRAMS.has(command.program)) return true;
  return (
    PARSED_WRITERS.has(command.program) &&
    !command.words.some((word) => word.includes('$'))
  );
}

// Word indexes sed and awk read as their script rather than as a file to
// edit: -e/--expression and -f/--file values, else the first operand, plus
// sed's BSD backup suffix and awk's -v and -F values.
function scriptWords({ start, program, args }: ScriptCommand): number[] {
  const sed = SED_PROGRAMS.has(program);
  if (!sed && !AWK_PROGRAMS.has(program)) return [];
  const found: number[] = [];
  let scriptGiven = false;
  let firstOperand = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const width = redirectWidth(arg);
    if (width > 0) {
      index += width - 1;
    } else if (
      /^(?:-f|--file)$/.test(arg) ||
      (sed && /^(?:-e|--expression)$/.test(arg))
    ) {
      scriptGiven = true;
      found.push(index + 1);
      index += 1;
    } else if (/^--(?:expression|file)=/.test(arg)) {
      scriptGiven = true;
      found.push(index);
    } else if (!sed && /^-[vF]$/.test(arg)) {
      found.push(index + 1);
      index += 1;
    } else if (
      sed &&
      /^-[a-zA-Z]*i$/.test(arg) &&
      index + 1 < args.length &&
      SED_SUFFIX_RE.test(args[index + 1])
    ) {
      found.push(index + 1);
      index += 1;
    } else if (firstOperand < 0 && !arg.startsWith('-')) {
      firstOperand = index;
    }
  }
  if (!scriptGiven && firstOperand >= 0) found.push(firstOperand);
  return found.map((index) => index + start + 1);
}

// The path a word names from the root or home, resolved: the word itself or
// its `--name=` value. null for anything else.
function rootedPath(word: string, cwd: Cwd): string | null {
  const value = LONG_OPTION_VALUE_RE.exec(word)?.[1] ?? word;
  if (!ROOTED_PATH_RE.test(value)) return null;
  const resolved = resolvePath(value, cwd);
  return resolved ? path.posix.resolve(resolved) : null;
}

interface NamedPaths {
  all: string[];
  // A command's program and the script an interpreter runs.
  run: Set<string>;
  elsewhere: Set<string>;
}

function collectNamedPaths(
  commands: ScriptCommand[],
  named: NamedPaths,
  depth: number,
): void {
  for (const command of commands) {
    const { words, start, program, args, cwd } = command;
    const source = codeSource(command);
    let script =
      source && 'file' in source && source.file !== words[start]
        ? source.file
        : null;
    const skip = new Set([...nonPathWords(command), ...scriptWords(command)]);
    if (source && 'inline' in source) {
      skip.add(words.indexOf(source.inline, start + 1));
    }
    words.forEach((word, index) => {
      if (skip.has(index)) return;
      const file = rootedPath(word, cwd);
      if (!file || file === '/') return;
      named.all.push(file);
      if (index === start || (index > start && word === script)) {
        if (index > start) script = null;
        named.run.add(file);
      } else {
        named.elsewhere.add(file);
      }
    });
    const nested =
      depth < MAX_NESTED_SCRIPT_DEPTH ? nestedScript(program, args) : null;
    if (nested) {
      collectNamedPaths(scriptCommands(nested, cwd), named, depth + 1);
    }
  }
}

// A line with any unparsed command keeps the whole fallback (owner call,
// 2026-09-27): a read can reach its writes through a pipe, `$(...)`, or a
// file, so fencing only each command's own paths was rejected. The fallback
// reads the parsed words, so quotes, `--name=/path`, and `~/` do not hide a
// path (owner call, 2026-09-27). Running a file does not write it. Deferred:
// an absolute target, even /dev/null, still skips the fallback.
export function fenceCandidates(
  commands: ScriptCommand[],
  isReadOnly: (words: string[]) => boolean,
): string[] {
  const targets = writeTargets(commands);
  // Relative targets are workspace-relative, so `../x` lands outside it.
  const climbing = targets.filter((target) => /^\.\.(?:\/|$)/.test(target));
  const absolute = targets.filter((target) => target.startsWith('/'));
  if (absolute.length > 0) return [...absolute, ...climbing];
  if (commands.every((command) => writesParsed(command, isReadOnly))) {
    return climbing;
  }
  const named: NamedPaths = { all: [], run: new Set(), elsewhere: new Set() };
  collectNamedPaths(commands, named, 0);
  const runOnly = (file: string) =>
    named.run.has(file) && !named.elsewhere.has(file);
  return [...named.all.filter((file) => !runOnly(file)), ...climbing];
}
