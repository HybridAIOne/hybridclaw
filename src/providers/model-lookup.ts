export function collectModelLookupCandidates(modelName: string): string[] {
  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return [];

  const candidates: string[] = [];
  const seen = new Set<string>();
  const queue = [normalized];

  while (queue.length > 0) {
    const candidate = queue.shift()?.trim().toLowerCase() ?? '';
    if (!candidate || seen.has(candidate)) continue;

    candidates.push(candidate);
    seen.add(candidate);

    if (candidate.includes('/')) {
      const parts = candidate.split('/').filter(Boolean);
      queue.push(parts.at(-1) ?? '');
      for (let index = 1; index < parts.length; index += 1) {
        queue.push(parts.slice(index).join('/'));
      }
    }

    if (candidate.includes(':')) {
      queue.push(...candidate.split(':'));
    }
  }

  return candidates;
}

export function matchesModelFamily(
  candidateId: string,
  targetId: string,
): boolean {
  if (!candidateId || !targetId) return false;
  if (candidateId === targetId) return true;
  const boundary = candidateId.at(targetId.length);
  return (
    candidateId.startsWith(targetId) &&
    (boundary === '-' ||
      boundary === '.' ||
      boundary === ':' ||
      boundary === '/')
  );
}
