import { matchesModelFamily } from './model-lookup.js';
import { resolveStaticModelCatalogMetadata } from './model-metadata.js';

interface HybridAIModel {
  id: string;
  contextWindowTokens: number | null;
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
  return resolveStaticModelCatalogMetadata(modelName).contextWindow;
}

/**
 * Returns true if the model is known to support vision (image_url content
 * parts) based on the static capability list.  Strips provider prefixes and
 * colon-separated suffixes so that ids like "openai-codex/gpt-5" or
 * "gpt-5:latest" still match.
 */
export function isStaticModelVisionCapable(modelName: string): boolean {
  return resolveStaticModelCatalogMetadata(modelName).capabilities.vision;
}
