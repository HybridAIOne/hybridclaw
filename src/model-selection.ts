export function normalizeModelCandidates(models: string[]): string[] {
  const deduped = new Set<string>();
  for (const model of models) {
    const candidate = String(model || '').trim();
    if (!candidate) continue;
    deduped.add(candidate);
  }
  return Array.from(deduped);
}

export function parseModelNamesFromListText(text: string): string[] {
  return normalizeModelCandidates(
    String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/\s+\((current|default)\)$/i, '')),
  );
}
