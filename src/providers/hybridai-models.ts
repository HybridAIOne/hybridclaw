interface HybridAIModel {
  id: string;
  contextWindowTokens: number | null;
}

// Models known to accept image_url content parts (vision-capable).
// Keep in sync with upstream provider documentation.
const STATIC_VISION_CAPABLE_MODELS = new Set<string>([
  // GPT-5 family (vision-enabled variants)
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
  'gpt-5.4': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 128_000,
};

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
  const matchesModelFamily = (
    candidateId: string,
    targetId: string,
  ): boolean => {
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
  const matchesModelFamily = (
    candidateId: string,
    targetId: string,
  ): boolean => {
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
  };

  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return null;

  const direct = STATIC_MODEL_CONTEXT_WINDOWS[normalized];
  if (direct != null) return direct;

  const slashTail = normalized.includes('/')
    ? (normalized.split('/').at(-1) ?? '')
    : normalized;
  if (slashTail && STATIC_MODEL_CONTEXT_WINDOWS[slashTail] != null) {
    return STATIC_MODEL_CONTEXT_WINDOWS[slashTail];
  }

  const colonTail = normalized.includes(':')
    ? (normalized.split(':').at(-1) ?? '')
    : normalized;
  if (colonTail && STATIC_MODEL_CONTEXT_WINDOWS[colonTail] != null) {
    return STATIC_MODEL_CONTEXT_WINDOWS[colonTail];
  }

  // Family fallback for versioned ids, e.g. "gpt-5.1-2025-11-13".
  const familyCandidates = [slashTail, colonTail, normalized].filter(Boolean);
  for (const candidate of familyCandidates) {
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
  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return false;

  if (STATIC_VISION_CAPABLE_MODELS.has(normalized)) return true;

  const slashTail = normalized.includes('/')
    ? (normalized.split('/').at(-1) ?? '')
    : normalized;
  if (slashTail && STATIC_VISION_CAPABLE_MODELS.has(slashTail)) return true;

  const colonTail = normalized.includes(':')
    ? (normalized.split(':').at(-1) ?? '')
    : normalized;
  if (colonTail && STATIC_VISION_CAPABLE_MODELS.has(colonTail)) return true;

  return false;
}
