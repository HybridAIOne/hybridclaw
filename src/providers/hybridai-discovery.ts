import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import {
  HYBRIDAI_BASE_URL,
  MissingRequiredEnvVarError,
} from '../config/config.js';
import { normalizeHybridAIModelForRuntime } from './model-names.js';
import { isRecord, normalizeBaseUrl } from './utils.js';

const HYBRIDAI_DISCOVERY_TTL_MS = 3_600_000;
const HYBRIDAI_DISCOVERY_PATHS = ['/models', '/v1/models'] as const;
const CONTEXT_WINDOW_KEYS = [
  'context_length',
  'contextLength',
  'max_context_length',
  'maxContextLength',
  'max_context_tokens',
  'maxContextTokens',
  'context_window',
  'contextWindow',
] as const;

function normalizeHybridAIModelName(modelId: string): string {
  return normalizeHybridAIModelForRuntime(String(modelId || '').trim());
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

function readModelId(entry: Record<string, unknown>): string {
  const rawId =
    typeof entry.id === 'string'
      ? entry.id
      : typeof entry.model === 'string'
        ? entry.model
        : typeof entry.name === 'string'
          ? entry.name
          : typeof entry.key === 'string'
            ? entry.key
            : '';
  return normalizeHybridAIModelName(rawId);
}

function readHybridAIContextWindow(
  entry: Record<string, unknown>,
): number | null {
  for (const key of CONTEXT_WINDOW_KEYS) {
    const parsed = readPositiveInteger(entry[key]);
    if (parsed != null) return parsed;
  }

  const limits = isRecord(entry.limits) ? entry.limits : null;
  if (!limits) return null;
  for (const key of CONTEXT_WINDOW_KEYS) {
    const parsed = readPositiveInteger(limits[key]);
    if (parsed != null) return parsed;
  }

  return null;
}

function getDiscoveryEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  if (isRecord(payload) && Array.isArray(payload.models)) return payload.models;
  return [];
}

export interface HybridAIDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  getModelContextWindow: (model: string) => number | null;
}

export function createHybridAIDiscoveryStore(): HybridAIDiscoveryStore {
  let discoveredModelNames: string[] = [];
  let contextWindowByModel = new Map<string, number>();
  let discoveredAtMs = 0;
  let discoveryInFlight: Promise<string[]> | null = null;

  function replaceDiscoveryCache(
    modelNames: string[],
    nextContextWindows: Iterable<[string, number]> = [],
    opts?: { cacheResult?: boolean },
  ): void {
    discoveredModelNames = [...modelNames];
    contextWindowByModel = new Map(nextContextWindows);
    discoveredAtMs = opts?.cacheResult === false ? 0 : Date.now();
  }

  async function fetchHybridAIModels(apiKey: string): Promise<string[]> {
    const baseUrl = normalizeBaseUrl(HYBRIDAI_BASE_URL);
    let response: Response | null = null;
    for (const path of HYBRIDAI_DISCOVERY_PATHS) {
      const candidate = await fetch(`${baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (candidate.ok) {
        response = candidate;
        break;
      }
      if (candidate.status !== 404) {
        throw new Error(`HTTP ${candidate.status}`);
      }
      response = candidate;
    }
    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
    }

    const payload = (await response.json()) as unknown;
    const discovered = new Set<string>();
    const contextWindows = new Map<string, number>();

    for (const entry of getDiscoveryEntries(payload)) {
      if (!isRecord(entry)) continue;
      const normalized = readModelId(entry);
      if (!normalized) continue;
      discovered.add(normalized);
      const contextWindow = readHybridAIContextWindow(entry);
      if (contextWindow != null) {
        contextWindows.set(normalized, contextWindow);
      }
    }

    replaceDiscoveryCache([...discovered], contextWindows);
    return [...discovered];
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    let apiKey = '';
    try {
      apiKey = getHybridAIApiKey();
    } catch (error) {
      if (
        error instanceof MissingRequiredEnvVarError &&
        error.envVar === 'HYBRIDAI_API_KEY'
      ) {
        replaceDiscoveryCache([], [], { cacheResult: false });
        return [];
      }
      throw error;
    }

    const cacheAgeMs = Date.now() - discoveredAtMs;
    if (
      !opts?.force &&
      discoveredAtMs > 0 &&
      cacheAgeMs < HYBRIDAI_DISCOVERY_TTL_MS
    ) {
      return [...discoveredModelNames];
    }

    if (discoveryInFlight) return discoveryInFlight;
    const stale = [...discoveredModelNames];

    discoveryInFlight = (async () => {
      try {
        await fetchHybridAIModels(apiKey);
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
    getModelContextWindow: (model: string) => {
      const normalized = normalizeHybridAIModelName(model);
      return contextWindowByModel.get(normalized) ?? null;
    },
  };
}

const defaultHybridAIDiscoveryStore = createHybridAIDiscoveryStore();

export async function discoverHybridAIModels(opts?: {
  force?: boolean;
}): Promise<string[]> {
  return defaultHybridAIDiscoveryStore.discoverModels(opts);
}

export function getDiscoveredHybridAIModelNames(): string[] {
  return defaultHybridAIDiscoveryStore.getModelNames();
}

export function getDiscoveredHybridAIModelContextWindow(
  model: string,
): number | null {
  return defaultHybridAIDiscoveryStore.getModelContextWindow(model);
}
