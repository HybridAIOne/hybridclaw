import { OPENROUTER_BASE_URL, OPENROUTER_ENABLED } from '../config/config.js';
import {
  buildOpenRouterAttributionHeaders,
  OPENROUTER_MODEL_PREFIX,
  readOpenRouterApiKey,
} from './openrouter-utils.js';
import { isRecord, normalizeBaseUrl } from './utils.js';

const OPENROUTER_DISCOVERY_TTL_MS = 3_600_000;
const OPENROUTER_PRICING_KEYS = [
  'prompt',
  'completion',
  'request',
  'image',
  'web_search',
  'internal_reasoning',
  'input_cache_read',
  'input_cache_write',
] as const;

function normalizeOpenRouterModelName(modelId: string): string {
  const normalized = String(modelId || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(OPENROUTER_MODEL_PREFIX)) {
    return normalized;
  }
  return `${OPENROUTER_MODEL_PREFIX}${normalized}`;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function readOpenRouterContextWindow(
  entry: Record<string, unknown>,
): number | null {
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : null;
  return (
    readPositiveInteger(entry.context_length) ??
    readPositiveInteger(entry.contextLength) ??
    readPositiveInteger(topProvider?.context_length) ??
    readPositiveInteger(topProvider?.contextLength)
  );
}

function isVisionCapableOpenRouterModel(
  entry: Record<string, unknown>,
): boolean {
  const architecture = isRecord(entry.architecture)
    ? entry.architecture
    : null;
  if (architecture) {
    const modality = String(architecture.modality || '').toLowerCase();
    // Modality strings like "text+image->text" indicate image input support.
    if (modality.includes('image')) return true;
  }
  // Some entries expose a top-level capabilities array or object.
  if (Array.isArray(entry.capabilities)) {
    return entry.capabilities.some(
      (cap: unknown) =>
        typeof cap === 'string' && /vision|image/i.test(cap),
    );
  }
  return false;
}

function isFreeOpenRouterModel(entry: Record<string, unknown>): boolean {
  const pricing = isRecord(entry.pricing) ? entry.pricing : null;
  if (!pricing) return false;

  let sawPrice = false;
  for (const key of OPENROUTER_PRICING_KEYS) {
    const value = pricing[key];
    if (value === undefined || value === null || value === '') continue;
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseFloat(value)
          : Number.NaN;
    if (!Number.isFinite(parsed)) return false;
    sawPrice = true;
    if (parsed !== 0) return false;
  }

  return sawPrice;
}

export interface OpenRouterDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  isModelFree: (model: string) => boolean;
  getModelContextWindow: (model: string) => number | null;
  isModelVisionCapable: (model: string) => boolean;
}

export function createOpenRouterDiscoveryStore(): OpenRouterDiscoveryStore {
  let discoveredModelNames: string[] = [];
  let freeModelNames = new Set<string>();
  let contextWindowByModel = new Map<string, number>();
  let visionCapableModels = new Set<string>();
  let discoveredAtMs = 0;
  let discoveryInFlight: Promise<string[]> | null = null;

  function replaceDiscoveryCache(
    modelNames: string[],
    nextFreeModelNames: Iterable<string> = [],
    nextContextWindows: Iterable<[string, number]> = [],
    nextVisionCapable: Iterable<string> = [],
    opts?: { cacheResult?: boolean },
  ): void {
    discoveredModelNames = [...modelNames];
    freeModelNames = new Set(nextFreeModelNames);
    contextWindowByModel = new Map(nextContextWindows);
    visionCapableModels = new Set(nextVisionCapable);
    discoveredAtMs = opts?.cacheResult === false ? 0 : Date.now();
  }

  async function fetchOpenRouterModels(apiKey: string): Promise<string[]> {
    const response = await fetch(
      `${normalizeBaseUrl(OPENROUTER_BASE_URL)}/models`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...buildOpenRouterAttributionHeaders(),
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const data =
      isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    const discovered = new Set<string>();
    const freeDiscovered = new Set<string>();
    const contextWindows = new Map<string, number>();
    const visionCapable = new Set<string>();
    for (const entry of data) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue;
      const normalized = normalizeOpenRouterModelName(entry.id);
      if (normalized) {
        discovered.add(normalized);
        const contextWindow = readOpenRouterContextWindow(entry);
        if (contextWindow != null) {
          contextWindows.set(normalized, contextWindow);
        }
        if (isFreeOpenRouterModel(entry)) {
          freeDiscovered.add(normalized);
        }
        if (isVisionCapableOpenRouterModel(entry)) {
          visionCapable.add(normalized);
        }
      }
    }
    replaceDiscoveryCache(
      [...discovered],
      freeDiscovered,
      contextWindows,
      visionCapable,
    );
    return [...discovered];
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!OPENROUTER_ENABLED) {
      replaceDiscoveryCache([], [], [], [], { cacheResult: false });
      return [];
    }

    const apiKey = readOpenRouterApiKey({ required: false });
    if (!apiKey) {
      replaceDiscoveryCache([], [], [], [], { cacheResult: false });
      return [];
    }

    const cacheAgeMs = Date.now() - discoveredAtMs;
    if (
      !opts?.force &&
      discoveredAtMs > 0 &&
      cacheAgeMs < OPENROUTER_DISCOVERY_TTL_MS
    ) {
      return [...discoveredModelNames];
    }

    if (discoveryInFlight) return discoveryInFlight;
    const stale = [...discoveredModelNames];

    discoveryInFlight = (async () => {
      try {
        await fetchOpenRouterModels(apiKey);
        return [...discoveredModelNames];
      } catch {
        return stale;
      } finally {
        discoveryInFlight = null;
      }
    })();

    return discoveryInFlight;
  }

  return {
    discoverModels,
    getModelNames: () => [...discoveredModelNames],
    isModelFree: (model: string) =>
      freeModelNames.has(String(model || '').trim()),
    getModelContextWindow: (model: string) => {
      const normalized = normalizeOpenRouterModelName(model);
      return contextWindowByModel.get(normalized) ?? null;
    },
    isModelVisionCapable: (model: string) => {
      const normalized = normalizeOpenRouterModelName(model);
      return visionCapableModels.has(normalized);
    },
  };
}

const defaultOpenRouterDiscoveryStore = createOpenRouterDiscoveryStore();

export async function discoverOpenRouterModels(opts?: {
  force?: boolean;
}): Promise<string[]> {
  return defaultOpenRouterDiscoveryStore.discoverModels(opts);
}

export function getDiscoveredOpenRouterModelNames(): string[] {
  return defaultOpenRouterDiscoveryStore.getModelNames();
}

export function isDiscoveredOpenRouterModelFree(model: string): boolean {
  return defaultOpenRouterDiscoveryStore.isModelFree(model);
}

export function getDiscoveredOpenRouterModelContextWindow(
  model: string,
): number | null {
  return defaultOpenRouterDiscoveryStore.getModelContextWindow(model);
}

export function isDiscoveredOpenRouterModelVisionCapable(
  model: string,
): boolean {
  return defaultOpenRouterDiscoveryStore.isModelVisionCapable(model);
}
