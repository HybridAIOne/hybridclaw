/**
 * Catalog search ranks routing metadata only; it never loads schemas or files.
 * Both discovery directories use the same deterministic keyword ordering.
 * Permission filtering belongs to their callers, before entries reach here.
 */
export function searchCatalog<T>(
  entries: readonly T[],
  query: string,
  metadata: (entry: T) => {
    name: string;
    description: string;
    keywords?: string;
  },
): T[] {
  // Engineering choice, 2026-09-10: bound lexical work; semantic search deferred.
  const phrase = query.trim().toLowerCase().slice(0, 256);
  const words = (text: string): string[] =>
    text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = [...new Set(words(phrase))].slice(0, 12);
  return entries
    .map((entry) => {
      const { name, description, keywords = '' } = metadata(entry);
      const nameWords = new Set(words(name));
      const bodyWords = new Set(words(`${description} ${keywords}`));
      let score = name.toLowerCase() === phrase ? 100 : 0;
      for (const term of terms) {
        if (nameWords.has(term)) score += 10;
        else if (bodyWords.has(term)) score += 2;
      }
      return { entry, name, score };
    })
    .filter(({ score }) => !phrase || score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map(({ entry }) => entry);
}
