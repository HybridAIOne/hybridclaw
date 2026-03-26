import type { MemoryCitation } from '../types/memory.js';

const CITATION_PATTERN = /\[mem:(\d+)\]/g;

export function extractMemoryCitations(
  responseText: string,
  citationIndex: MemoryCitation[],
): MemoryCitation[] {
  const seen = new Set<number>();
  const cited: MemoryCitation[] = [];

  for (const match of responseText.matchAll(CITATION_PATTERN)) {
    const idx = Number.parseInt(match[1], 10) - 1;
    if (idx >= 0 && idx < citationIndex.length && !seen.has(idx)) {
      seen.add(idx);
      cited.push(citationIndex[idx]);
    }
  }

  return cited;
}
