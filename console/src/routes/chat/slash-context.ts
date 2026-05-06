// The query spans every character after the slash through the cursor —
// multi-word, so `/agent install` keeps showing subcommand suggestions
// instead of closing the panel at the first space.
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
