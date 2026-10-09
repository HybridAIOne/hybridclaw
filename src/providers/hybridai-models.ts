import { resolveStaticModelCatalogMetadata } from './model-metadata.js';

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
