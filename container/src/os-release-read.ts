/**
 * Exempts verified OS-identification reads from default path pins only.
 * Each shell command touching that path must be a direct reader; unrelated
 * commands retain their own approval checks. This is not shell authorization.
 */
import fs from 'node:fs';
import {
  type Cwd,
  commandWriteTargets,
  resolvePath,
  scriptCommands,
} from './bash-commands.js';

const OS_RELEASE_PATH = '/etc/os-release';
const OS_READERS = new Set(['cat', 'head', 'tail']);

export function osReleaseReadPath(
  toolName: string,
  args: Record<string, unknown>,
  cwd: Cwd = '',
): string | null {
  if (toolName !== 'read' && toolName !== 'bash') return null;
  // Owner request, 2026-11-08: classify access to the OS file, not its neighbours.
  try {
    const target = fs.realpathSync(OS_RELEASE_PATH);
    if (target !== OS_RELEASE_PATH && target !== '/usr/lib/os-release')
      return null;
  } catch {
    return null;
  }
  if (toolName === 'read')
    return args.path === OS_RELEASE_PATH ? OS_RELEASE_PATH : null;
  if (typeof args.command !== 'string') return null;
  let read = false;
  let readingPipe = false;
  for (const entry of scriptCommands(args.command, cwd)) {
    if (!entry.piped) readingPipe = false;
    const writes = commandWriteTargets(entry.words);
    if (
      writes.some(
        (target) => resolvePath(target, entry.cwd) === OS_RELEASE_PATH,
      )
    )
      return null;
    const touchesPath = (word: string) =>
      word.includes(OS_RELEASE_PATH) ||
      resolvePath(word, entry.cwd) === OS_RELEASE_PATH ||
      (word.includes('os-release') && /[/$]/.test(word));
    const namesPath = entry.words.some(touchesPath);
    if (!namesPath && !readingPipe) continue;
    const executable = entry.words[entry.start];
    if (
      entry.start !== 0 ||
      !OS_READERS.has(entry.program) ||
      ![
        entry.program,
        `/bin/${entry.program}`,
        `/usr/bin/${entry.program}`,
      ].includes(executable) ||
      (namesPath &&
        !entry.args.some(
          (arg) => resolvePath(arg, entry.cwd) === OS_RELEASE_PATH,
        )) ||
      writes.length > 0
    )
      return null;
    read = true;
    readingPipe = entry.pipesOut;
  }
  return read ? OS_RELEASE_PATH : null;
}
