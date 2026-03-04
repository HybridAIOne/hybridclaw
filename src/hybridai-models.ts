import { getHybridAIApiKey, HYBRIDAI_BASE_URL } from './config.js';

interface HybridAIModel {
  id: string;
  contextWindowTokens: number | null;
}

interface ModelCacheEntry {
  models: HybridAIModel[];
  fetchedAtMs: number;
}

const MODEL_LIST_PATHS = ['/v1/models', '/api/v1/model-management/models'];

let modelCache: ModelCacheEntry | null = null;

const FALLBACK_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5-nano': 128_000,
  'gpt-5-mini': 272_000,
  'gpt-5': 400_000,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function firstPositiveNumber(values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberFromUnknown(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function extractContextWindowTokens(
  item: Record<string, unknown>,
): number | null {
  const usageRecord = asRecord(item.usage);
  const limitsRecord = asRecord(item.limits);
  const metadataRecord = asRecord(item.metadata);
  const modelRecord = asRecord(item.model);
  const capabilitiesRecord = asRecord(item.capabilities);

  return firstPositiveNumber([
    item.context_window,
    item.contextWindow,
    item.context_length,
    item.contextLength,
    item.max_context_tokens,
    item.maxContextTokens,
    item.max_context_size,
    item.maxContextSize,
    item.token_limit,
    item.tokenLimit,
    usageRecord?.context_window,
    usageRecord?.max_context_tokens,
    limitsRecord?.context_window,
    limitsRecord?.max_context_tokens,
    metadataRecord?.context_window,
    metadataRecord?.context_length,
    modelRecord?.context_window,
    modelRecord?.max_context_tokens,
    capabilitiesRecord?.context_window,
    capabilitiesRecord?.max_context_tokens,
  ]);
}

function normalizeModels(payload: unknown): HybridAIModel[] {
  const rootRecord = asRecord(payload);
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(rootRecord?.data)
      ? rootRecord.data
      : Array.isArray(rootRecord?.models)
        ? rootRecord.models
        : Array.isArray(rootRecord?.items)
          ? rootRecord.items
          : [];
  const results: HybridAIModel[] = [];
  for (const raw of rawItems) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = String(item.id ?? item.model ?? item.name ?? '').trim();
    if (!id) continue;
    results.push({
      id,
      contextWindowTokens: extractContextWindowTokens(item),
    });
  }
  return results;
}

async function fetchFromPath(pathname: string): Promise<HybridAIModel[]> {
  const url = `${HYBRIDAI_BASE_URL}${pathname}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getHybridAIApiKey()}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch models: ${res.status} ${res.statusText}`);
  }
  return normalizeModels(await res.json());
}

export async function fetchHybridAIModels(options?: {
  cacheTtlMs?: number;
}): Promise<HybridAIModel[]> {
  const cacheTtlMs = Math.max(0, options?.cacheTtlMs ?? 0);
  const now = Date.now();
  if (
    cacheTtlMs > 0 &&
    modelCache &&
    now - modelCache.fetchedAtMs < cacheTtlMs
  ) {
    return modelCache.models;
  }

  let lastError: Error | null = null;
  for (const pathname of MODEL_LIST_PATHS) {
    try {
      const models = await fetchFromPath(pathname);
      if (cacheTtlMs > 0) {
        modelCache = { models, fetchedAtMs: now };
      } else {
        modelCache = null;
      }
      return models;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (modelCache?.models.length) return modelCache.models;
  if (lastError) throw lastError;
  return [];
}

export function resolveModelContextWindowFromList(
  models: HybridAIModel[],
  modelName: string,
): number | null {
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
    const normalizedId = entry.id.trim().toLowerCase();
    const normalizedTail = normalizedId.includes('/')
      ? (normalizedId.split('/').at(-1) ?? '')
      : normalizedId;
    return normalizedTail === targetTail;
  });
  return tailMatch?.contextWindowTokens ?? null;
}

export function resolveModelContextWindowFallback(
  modelName: string,
): number | null {
  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return null;

  const direct = FALLBACK_MODEL_CONTEXT_WINDOWS[normalized];
  if (direct != null) return direct;

  const slashTail = normalized.includes('/')
    ? (normalized.split('/').at(-1) ?? '')
    : normalized;
  if (slashTail && FALLBACK_MODEL_CONTEXT_WINDOWS[slashTail] != null) {
    return FALLBACK_MODEL_CONTEXT_WINDOWS[slashTail];
  }

  const colonTail = normalized.includes(':')
    ? (normalized.split(':').at(-1) ?? '')
    : normalized;
  if (colonTail && FALLBACK_MODEL_CONTEXT_WINDOWS[colonTail] != null) {
    return FALLBACK_MODEL_CONTEXT_WINDOWS[colonTail];
  }

  return null;
}
