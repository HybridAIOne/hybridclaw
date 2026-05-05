/**
 * Locate the slash-token at `cursor`. Lets the panel trigger mid-line
 * (e.g. `hello /clear`), not just at column 0.
 */
export function getSlashContext(
  value: string,
  cursor: number,
): { query: string; tokenStart: number; tokenEnd: number } | null {
  const before = value.slice(0, cursor);
  const wsIdx = Math.max(
    before.lastIndexOf(' '),
    before.lastIndexOf('\n'),
    before.lastIndexOf('\t'),
  );
  const tokenStart = wsIdx + 1;
  const after = value.slice(cursor);
  const nextWsRel = after.search(/\s/);
  const tokenEnd = nextWsRel === -1 ? value.length : cursor + nextWsRel;
  const token = value.slice(tokenStart, tokenEnd);
  if (!token.startsWith('/')) return null;
  return { query: token.slice(1), tokenStart, tokenEnd };
}
