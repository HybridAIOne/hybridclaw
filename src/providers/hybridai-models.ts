interface HybridAIModel {
  id: string;
  contextWindowTokens: number | null;
}

// Models known to accept image_url content parts (vision-capable).
// Keep in sync with upstream provider documentation.
const STATIC_VISION_CAPABLE_MODELS = new Set<string>([
  // GPT-5 family (vision-enabled variants)
  'gpt-4.1-mini',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-pro',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.2-pro',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.4',

  // Claude family
  'claude-opus-4-6',
  'claude-opus-4.6',
  'claude-sonnet-4-6',
  'claude-sonnet-4.6',

  // Gemini family
  'gemini-3',
  'gemini-3-pro',
  'gemini-3-flash',
  'gemini-3.1',
  'gemini-3.1-pro',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
]);

// Source: ../../examples/pi-mono/packages/ai/src/models.generated.ts
// Keep this list intentionally small and focused on the GPT-5 family we use.
const STATIC_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude 4.6
  'claude-opus-4-6': 200_000,
  'claude-opus-4.6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4.6': 200_000,

  // Gemini 3 / 3.1
  'gemini-3': 1_048_576,
  'gemini-3-pro': 1_048_576,
  'gemini-3-flash': 1_048_576,
  'gemini-3.1': 1_048_576,
  'gemini-3.1-pro': 1_048_576,
  'gemini-3.1-pro-high': 1_048_576,
  'gemini-3.1-pro-low': 1_048_576,
  'gemini-3-pro-preview': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  'gemini-3.1-pro-preview': 1_048_576,

  // GPT-5 family
  'gpt-4.1-mini': 1_047_576,
  'gpt-5': 400_000,
  'gpt-5-chat-latest': 128_000,
  'gpt-5-codex': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5-nano': 400_000,
  'gpt-5-pro': 400_000,
  'gpt-5.1': 400_000,
  'gpt-5.1-chat-latest': 128_000,
  'gpt-5.1-codex': 400_000,
  'gpt-5.1-codex-max': 400_000,
  'gpt-5.1-codex-mini': 400_000,
  'gpt-5.2': 400_000,
  'gpt-5.2-chat-latest': 128_000,
  'gpt-5.2-codex': 400_000,
  'gpt-5.2-pro': 400_000,
  'gpt-5.4-mini': 272_000,
  'gpt-5.4': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 128_000,
};

function collectModelLookupCandidates(modelName: string): string[] {
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
      queue.push(candidate.split('/').at(-1) ?? '');
    }

    if (candidate.includes(':')) {
      queue.push(...candidate.split(':'));
    }
  }

  return candidates;
}

function matchesModelFamily(candidateId: string, targetId: string): boolean {
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

export function resolveModelContextWindowFromList(
  models: HybridAIModel[],
  modelName: string,
): number | null {
  const normalizeModelIdTail = (modelId: string): string => {
    const normalized = modelId.trim().toLowerCase();
    return normalized.includes('/')
      ? (normalized.split('/').at(-1) ?? normalized)
      : normalized;
  };

  const target = modelName.trim().toLowerCase();
  if (!target) return null;

  const direct = models.find(
    (entry) =>
      entry.contextWindowTokens != null &&
      entry.id.trim().toLowerCase() === target,
  );
  if (direct?.contextWindowTokens != null) return direct.contextWindowTokens;

  const targetTail = target.includes('/')
    ? (target.split('/').at(-1) ?? '')
    : target;
  if (!targetTail) return null;

  const tailMatch = models.find((entry) => {
    if (entry.contextWindowTokens == null) return false;
    const normalizedTail = normalizeModelIdTail(entry.id);
    return normalizedTail === targetTail;
  });
  if (tailMatch?.contextWindowTokens != null)
    return tailMatch.contextWindowTokens;

  const familyMatch = models
    .filter((entry) => entry.contextWindowTokens != null)
    .map((entry) => ({
      contextWindowTokens: entry.contextWindowTokens as number,
      tail: normalizeModelIdTail(entry.id),
    }))
    .filter((entry) => matchesModelFamily(entry.tail, targetTail))
    .sort((a, b) => b.tail.length - a.tail.length)
    .at(0);
  return familyMatch?.contextWindowTokens ?? null;
}

export function resolveModelContextWindowFallback(
  modelName: string,
): number | null {
  const candidates = collectModelLookupCandidates(modelName);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const direct = STATIC_MODEL_CONTEXT_WINDOWS[candidate];
    if (direct != null) return direct;
  }

  // Family fallback for derived ids such as "gpt-5.1-2025-11-13" or
  // provider/tag forms like "openai/gpt-5:latest".
  for (const candidate of candidates) {
    const bestMatch = Object.keys(STATIC_MODEL_CONTEXT_WINDOWS)
      .filter((key) => matchesModelFamily(candidate, key))
      .sort((a, b) => b.length - a.length)
      .at(0);
    if (bestMatch) return STATIC_MODEL_CONTEXT_WINDOWS[bestMatch] ?? null;
  }

  return null;
}

/**
 * Returns true if the model is known to support vision (image_url content
 * parts) based on the static capability list.  Strips provider prefixes and
 * colon-separated suffixes so that ids like "openai-codex/gpt-5" or
 * "gpt-5:latest" still match.
 */
export function isStaticModelVisionCapable(modelName: string): boolean {
  return collectModelLookupCandidates(modelName).some((candidate) =>
    STATIC_VISION_CAPABLE_MODELS.has(candidate),
  );
}
