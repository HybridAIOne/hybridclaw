/**
 * Locate the slash-command being typed at `cursor`. The query spans every
 * character from the most recent slash that starts a token (column 0 of the
 * current line, or after whitespace) through the cursor — multi-word, so
 * `/agent install` keeps showing subcommand suggestions as the user types.
 * Lets the panel trigger mid-line (e.g. `hello /clear`), not just at column 0.
 */
export function getSlashContext(
  value: string,
  cursor: number,
): { query: string; tokenStart: number } | null {
  const lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
  let slashAt = -1;
  for (let i = lineStart; i < cursor; i++) {
    if (value[i] !== '/') continue;
    if (i === lineStart || /\s/.test(value[i - 1])) slashAt = i;
  }
  if (slashAt === -1) return null;
  return { query: value.slice(slashAt + 1, cursor), tokenStart: slashAt };
}
