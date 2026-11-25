/**
 * Bounds an initial grep search to absolute file operands on the shell's
 * filesystem. The walk classifier still owns approval for uncertain roots.
 * Filesystem observations are made at review time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { commandArguments, type ScriptCommand } from './bash-commands.js';
import { TASK_SANDBOX_FS_ENABLED } from './runtime-paths.js';

export const GREP_FILE_SEARCH_REPLAN = 'bash:grep-file-search';
const FILE_PATH =
  /^\/(?:[A-Za-z0-9._-]+\/)*(?:[A-Za-z0-9._-]+|\*)\.[A-Za-z0-9]+$/;
const SIMPLE_RECURSION = /^(?:-r|-rn|-nr|--recursive)$/;
const UNKNOWN_PATTERN = /^-|[$`*?[\]{}~]/;

export function hasLiteralGrepFileOperands(command: ScriptCommand): boolean {
  if (TASK_SANDBOX_FS_ENABLED || command.words[0] !== 'grep') return false;
  const [flags, pattern, ...files] = commandArguments(command.args);
  return (
    SIMPLE_RECURSION.test(flags ?? '') &&
    pattern !== undefined &&
    !UNKNOWN_PATTERN.test(pattern) &&
    files.length > 0 &&
    files.every((file) => FILE_PATH.test(file) && path.normalize(file) === file)
  );
}

export function initialGrepFileSearch(
  script: string,
  commands: ScriptCommand[],
): ScriptCommand | undefined {
  // A preceding command can replace a checked operand or change shell
  // expansion. A pipeline consumer can do the same concurrently.
  const [first, next] = commands;
  if (
    TASK_SANDBOX_FS_ENABLED ||
    process.env.BASH_ENV ||
    process.env.BASHOPTS?.split(':').includes('nullglob') ||
    !/^\s*grep[ \t]/.test(script) ||
    /[&(){}]/.test(script) ||
    first?.words[0] !== 'grep'
  ) {
    return undefined;
  }
  if (commandArguments(first.args).length !== first.args.length)
    return undefined;
  if (
    first.pipesOut &&
    (!next ||
      next.pipesOut ||
      next.words[0] !== 'head' ||
      !/^head(?: -[0-9]+| -n [0-9]+)?$/.test(next.words.join(' ')))
  ) {
    return undefined;
  }
  return first;
}

export function grepOperandIsFileOnly(
  operand: string,
  namesPinnedPath: (candidate: string) => boolean,
): boolean {
  const parent = path.dirname(operand);
  try {
    if (
      fs.realpathSync(parent) !== parent ||
      !fs.statSync(parent).isDirectory() ||
      namesPinnedPath(parent) ||
      namesPinnedPath(operand)
    ) {
      return false;
    }
    const name = path.basename(operand);
    if (!name.startsWith('*')) {
      try {
        return fs.lstatSync(operand).isFile();
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    }

    const suffix = name.slice(1);
    const foldedSuffix = suffix.toLowerCase();
    const directory = fs.opendirSync(parent);
    let matches = false;
    try {
      // 4096 entries (Codex, 2026-11-24): bound synchronous review work.
      for (let count = 0; count < 4096; count += 1) {
        const entry = directory.readSync();
        if (!entry) return matches;
        if (!entry.name.toLowerCase().endsWith(foldedSuffix)) continue;
        if (!entry.isFile() || namesPinnedPath(path.join(parent, entry.name))) {
          return false;
        }
        matches ||= !entry.name.startsWith('.') && entry.name.endsWith(suffix);
      }
    } finally {
      directory.closeSync();
    }
  } catch {
    return false;
  }
  return false;
}
