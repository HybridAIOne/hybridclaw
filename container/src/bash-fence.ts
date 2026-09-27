/**
 * Paths the workspace fence checks for one bash line. Every write target the
 * parser resolves counts. When none is absolute and some command writes in
 * ways the parser does not follow (`rm`, `sed -i`, installers, interpreters,
 * unknown programs), every absolute path the line names counts too, except
 * files the line only runs. Reading from outside is never a write.
 *
 * NOT the decision: approval-policy.ts drops workspace, scratch, and
 * /dev/null paths. What each command writes is bash-commands.ts.
 */
import path from 'node:path';
import {
  deletesFiles,
  OPERAND_WRITERS,
  type ScriptCommand,
  shellCommandsRun,
  writeTargets,
} from './bash-commands.js';
import { NAME_ONLY_PROGRAMS } from './bash-pinned-reach.js';
import { codeSource } from './bash-remote-code.js';

// Programs whose writes writeTargets() resolves in full unless an operand
// hides behind a variable or substitution. mv is not one: it removes its
// sources.
const PARSED_WRITERS = new Set([...OPERAND_WRITERS, 'cd', 'cp', 'pushd']);

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

// Absolute paths the line only runs: a command's program and the script an
// interpreter runs. Running a file does not write it; a path the line also
// names elsewhere still counts.
function runOnlyPaths(commands: ScriptCommand[]): Set<string> {
  const runs = new Set<string>();
  const other = new Set<string>();
  for (const command of commands) {
    const source = codeSource(command);
    const program = command.words[command.start];
    let script =
      source && 'file' in source && source.file !== program
        ? source.file
        : null;
    command.words.forEach((word, index) => {
      if (!word.startsWith('/')) return;
      if (
        index === command.start ||
        (index > command.start && word === script)
      ) {
        if (index > command.start) script = null;
        runs.add(path.posix.resolve(word));
      } else {
        other.add(path.posix.resolve(word));
      }
    });
  }
  return new Set([...runs].filter((file) => !other.has(file)));
}

// `namedPaths` are the absolute paths the line names, resolved. A line with
// any unparsed command keeps the whole fallback (owner call, 2026-09-27): a
// read can reach its writes through a pipe, `$(...)`, or a file, so fencing
// only each command's own paths was rejected. Deferred: an absolute target,
// even /dev/null, still skips the fallback.
export function fenceCandidates(
  commands: ScriptCommand[],
  namedPaths: string[],
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
  const runOnly = runOnlyPaths(commands);
  return [...namedPaths.filter((named) => !runOnly.has(named)), ...climbing];
}
