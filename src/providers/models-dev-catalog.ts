/**
 * Adapter for the models.dev community catalog (https://models.dev/api.json,
 * MIT-licensed, https://github.com/anomalyco/models.dev). Fetched on demand
 * with a 24h TTL and cached in memory; failures degrade silently so the
 * picker just doesn't show capability badges instead of erroring.
 */

const CATALOG_URL = 'https://models.dev/api.json';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 8_000;

export type ModelCostTier = 'low' | 'medium' | 'high' | 'highest';

export interface ModelMetadata {
  supportsVision: boolean;
  supportsTools: boolean;
  supportsImageGen: boolean;
  isReasoning: boolean | null;
  costTier: ModelCostTier | null;
  knowledgeCutoff: string | null;
  contextWindow: number | null;
}

interface ModelsDevModel {
  id: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  knowledge?: string;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number };
  limit?: { context?: number; output?: number };
}

interface ModelsDevProvider {
  id: string;
  models: Record<string, ModelsDevModel>;
}

interface FlatEntry extends ModelMetadata {
  id: string;
}

let inMemoryCache: {
  entries: Map<string, FlatEntry>;
  loadedAt: number;
} | null = null;
let pendingLoad: Promise<Map<string, FlatEntry>> | null = null;

function bucketCostTier(
  inputPricePerMillion: number | null,
): ModelCostTier | null {
  if (inputPricePerMillion == null || !Number.isFinite(inputPricePerMillion)) {
    return null;
  }
  if (inputPricePerMillion < 1) return 'low';
  if (inputPricePerMillion < 5) return 'medium';
  if (inputPricePerMillion < 15) return 'high';
  return 'highest';
}

function flattenCatalog(
  data: Record<string, ModelsDevProvider>,
): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  for (const provider of Object.values(data)) {
    if (!provider?.models) continue;
    for (const model of Object.values(provider.models)) {
      const id = (model.id || '').trim().toLowerCase();
      if (!id) continue;
      const inputModalities = new Set(model.modalities?.input ?? []);
      const outputModalities = new Set(model.modalities?.output ?? []);
      const entry: FlatEntry = {
        id,
        supportsVision:
          inputModalities.has('image') || inputModalities.has('pdf'),
        supportsTools: Boolean(model.tool_call),
        supportsImageGen: outputModalities.has('image'),
        isReasoning:
          typeof model.reasoning === 'boolean' ? model.reasoning : null,
        costTier: bucketCostTier(model.cost?.input ?? null),
        knowledgeCutoff: model.knowledge?.trim() || null,
        contextWindow:
          typeof model.limit?.context === 'number' ? model.limit.context : null,
      };
      // Last writer wins; with provider iteration order, this prefers the
      // alphabetically-last provider's entry for shared model ids. The data
      // is largely consistent across providers for the same id, so the
      // collision matters little.
      out.set(id, entry);
    }
  }
  return out;
}

async function loadCatalog(): Promise<Map<string, FlatEntry>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CATALOG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CATALOG_URL, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`models.dev catalog fetch ${res.status}`);
    }
    const json = (await res.json()) as Record<string, ModelsDevProvider>;
    return flattenCatalog(json);
  } finally {
    clearTimeout(timer);
  }
}

async function ensureCatalog(): Promise<Map<string, FlatEntry>> {
  const now = Date.now();
  if (inMemoryCache && now - inMemoryCache.loadedAt < CATALOG_TTL_MS) {
    return inMemoryCache.entries;
  }
  if (pendingLoad) return pendingLoad;
  pendingLoad = loadCatalog()
    .then((entries) => {
      inMemoryCache = { entries, loadedAt: Date.now() };
      return entries;
    })
    .catch((err) => {
      console.warn(
        '[models-dev] catalog fetch failed, capability metadata will be unavailable',
        err instanceof Error ? err.message : err,
      );
      // Cache an empty result for the TTL so we don't hammer the endpoint
      // when it's down. Returns the existing cache if we have one, else empty.
      const fallback = inMemoryCache?.entries ?? new Map<string, FlatEntry>();
      inMemoryCache = { entries: fallback, loadedAt: Date.now() };
      return fallback;
    })
    .finally(() => {
      pendingLoad = null;
    });
  return pendingLoad;
}

function lookupCandidates(modelId: string): string[] {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return [];
  const out: string[] = [normalized];
  if (normalized.includes('/')) {
    const tail = normalized.split('/').at(-1) ?? '';
    if (tail) out.push(tail);
  }
  if (normalized.includes(':')) {
    out.push(...normalized.split(':').filter(Boolean));
  }
  return out;
}

/**
 * Returns capability/cost metadata for `modelId` from the cached models.dev
 * catalog, or `null` if not found. Does not block — kicks off a background
 * fetch on first call. Subsequent calls return the populated cache.
 */
export function lookupModelMetadata(modelId: string): ModelMetadata | null {
  // Kick off a load; ignore the promise here. The first caller eats the cache
  // miss; later callers see the populated map.
  void ensureCatalog();
  if (!inMemoryCache) return null;
  for (const candidate of lookupCandidates(modelId)) {
    const direct = inMemoryCache.entries.get(candidate);
    if (direct) return stripId(direct);
  }
  // Family-prefix fallback for derived ids ("gpt-5.1-2025-11-13" -> "gpt-5.1").
  for (const candidate of lookupCandidates(modelId)) {
    let best: FlatEntry | null = null;
    for (const [key, entry] of inMemoryCache.entries) {
      if (
        candidate.startsWith(`${key}-`) ||
        candidate.startsWith(`${key}.`) ||
        candidate.startsWith(`${key}:`)
      ) {
        if (!best || key.length > best.id.length) best = entry;
      }
    }
    if (best) return stripId(best);
  }
  return null;
}

function stripId(entry: FlatEntry): ModelMetadata {
  const { id: _id, ...rest } = entry;
  return rest;
}

/** Force a fresh fetch on next call. Test-only. */
export function _resetModelsDevCacheForTest(): void {
  inMemoryCache = null;
  pendingLoad = null;
}

/** Eager-load the catalog (e.g. at gateway startup) so the first picker
 * request doesn't see a cache miss. Awaits the fetch but never throws. */
export async function preloadModelsDevCatalog(): Promise<void> {
  try {
    await ensureCatalog();
  } catch {
    // ensureCatalog already swallows + logs; this is belt-and-suspenders.
  }
}
