/**
 * A literal quoted Python stdin program has the same code origin as `-c`.
 * This builds an inspection view only; execution still receives the original
 * command. Expanded stdin, wrappers and additional heredocs stay opaque.
 */
import {
  PYTHON_PROGRAM_RE,
  type ScriptCommand,
  scriptCommands,
} from './bash-commands.js';
import {
  inspectPythonInline,
  MAX_PYTHON_SOURCE_BYTES,
} from './python-data-inspection.js';

export function quotedPythonStdinCommands(
  command: string,
): ScriptCommand[] | null {
  if (Buffer.byteLength(command) > MAX_PYTHON_SOURCE_BYTES) return null;
  const match = command.match(
    /^([ \t]*(?:cd[ \t]+[\w./~-]+[ \t]*&&[ \t]*)?)([\w.]+)[ \t]+(?:-[ \t]+)?<<[ \t]*(?:'(\w+)'|"(\w+)")[ \t]*\r?\n/,
  );
  if (!match || !PYTHON_PROGRAM_RE.test(match[2])) return null;
  const delimiter = match[3] ?? match[4];
  const lines = command.slice(match[0].length).split('\n');
  const end = lines.findIndex((line) => line.replace(/\r$/, '') === delimiter);
  if (end < 0) return null;
  const tail = lines.slice(end + 1).join('\n');
  if (tail.includes('<<')) return null;
  const commands = scriptCommands(`${match[1]}${match[2]} -c ''`);
  const python = commands.at(-1);
  if (!python || python.program !== match[2]) return null;
  const source = lines.slice(0, end).join('\n');
  if (!inspectPythonInline(source, [], python.cwd)?.data) return null;
  // Preserve the parser's literal argument role without shell-quoting source.
  python.args[1] = source;
  python.words[python.start + 2] = source;
  return [...commands, ...scriptCommands(tail, python.cwd)];
}
