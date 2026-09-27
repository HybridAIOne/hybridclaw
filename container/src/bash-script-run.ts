/**
 * Script execution: a shell given a file (`bash -x install.sh`), a path the
 * agent could have written run as the program (`./install.sh`, `/tmp/x`), or
 * ripgrep's `--pre` program. A path that is only an operand (`cat ./x.sh`)
 * runs nothing. NOT the fetched-code check (bash-remote-code.ts asks where the
 * file came from), and other interpreters (`python3 x.py`, `source x`) are out.
 */
import {
  commandProgram,
  resolvePath,
  runsProgramOption,
  SHELL_PROGRAMS,
} from './bash-commands.js';
import { codeSource } from './bash-remote-code.js';

// One command, as shellCommandsRun() lists it. `agentWritable` says whether an
// absolute path is in the workspace or scratch space.
export function runsScript(
  words: string[],
  agentWritable: (absolutePath: string) => boolean,
): boolean {
  if (runsProgramOption(words)) return true;
  const command = { words, ...commandProgram(words) };
  const source = codeSource(command);
  if (source === null || !('file' in source)) return false;
  if (SHELL_PROGRAMS.has(command.program)) return true;
  // Owner call, 2026-09-27: other interpreters keep their tier, and a path run
  // as the program counts only when the agent could have written it: relative,
  // behind a variable, or in the workspace or scratch space. Installed tools
  // called by absolute path (`/usr/bin/env`, Homebrew) keep their tier.
  if (source.file !== words[command.start]) return false;
  const resolved = resolvePath(source.file, '');
  return (
    resolved === null || !resolved.startsWith('/') || agentWritable(resolved)
  );
}
