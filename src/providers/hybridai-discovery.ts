import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import {
  HYBRIDAI_BASE_URL,
  MissingRequiredEnvVarError,
} from '../config/config.js';
import { logger } from '../logger.js';
import {
  formatHybridAIModelForCatalog,
  stripHybridAIModelPrefix,
} from './model-names.js';
import {
  createDiscoveryStore,
  isRecord,
  normalizeBaseUrl,
  readPositiveInteger,
} from './utils.js';

const HYBRIDAI_DISCOVERY_PATHS = ['/models', '/v1/models'] as const;
const HYBRIDAI_PROVIDER_FAMILY_PREFIXES = new Set([
  'anthropic',
  'huggingface',
  'mistral',
]);

function normalizeHybridAIProviderFamily(value: unknown): string | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized || !HYBRIDAI_PROVIDER_FAMILY_PREFIXES.has(normalized)) {
    return null;
  }
  return normalized;
}

function readHybridAIProviderFamily(
  entry: Record<string, unknown>,
): string | null {
  return (
    normalizeHybridAIProviderFamily(entry.provider) ||
    normalizeHybridAIProviderFamily(entry.owned_by) ||
    normalizeHybridAIProviderFamily(entry.vendor) ||
    normalizeHybridAIProviderFamily(entry.family)
  );
}

function normalizeHybridAIModelName(
  modelId: string,
  providerFamily?: string | null,
): string {
  const normalizedModelId = String(modelId || '').trim();
  if (!normalizedModelId) return '';
  if (normalizedModelId.includes('/')) {
    return formatHybridAIModelForCatalog(normalizedModelId);
  }
  if (providerFamily) {
    return formatHybridAIModelForCatalog(
      `${providerFamily}/${normalizedModelId}`,
    );
  }
  return formatHybridAIModelForCatalog(normalizedModelId);
}

function readModelId(entry: Record<string, unknown>): string {
  return normalizeHybridAIModelName(
    typeof entry.id === 'string' ? entry.id : '',
    readHybridAIProviderFamily(entry),
  );
}

function readHybridAIContextWindow(
  entry: Record<string, unknown>,
): number | null {
  return readPositiveInteger(entry.context_length);
}

function getDiscoveryEntries(payload: unknown): unknown[] {
  // Observed HybridAI discovery responses in
  // tests/model-catalog.test.ts and tests/gateway-status.test.ts use
  // `{ data: [...] }`. Keep the bare-array and `{ models: [...] }` branches as
  // compatibility shims for older or self-hosted deployments that may not wrap
  // entries the same way.
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  if (isRecord(payload) && Array.isArray(payload.models)) return payload.models;
  return [];
}

function resolveCachedHybridAIModelKey(
  model: string,
  cachedKeys: Iterable<string>,
): string {
  const requested = String(model || '').trim();
  const normalized = normalizeHybridAIModelName(requested);
  const keys = [...cachedKeys];
  if (keys.includes(normalized)) return normalized;

  const requestedTail = requested.split('/').at(-1)?.toLowerCase() || '';
  if (!requestedTail) return normalized;

  const matchingKeys = keys.filter((key) => {
    const upstream = stripHybridAIModelPrefix(key);
    const upstreamTail = upstream.split('/').at(-1)?.toLowerCase() || '';
    return (
      upstream.toLowerCase() === requested.toLowerCase() ||
      upstreamTail === requestedTail
    );
  });
  return matchingKeys.length === 1 ? matchingKeys[0] : normalized;
}

export interface HybridAIDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  getModelContextWindow: (model: string) => number | null;
  getModelMaxTokens: (model: string) => number | null;
}

interface HybridAIDiscoveryState {
  discoveredModelNames: string[];
  contextWindowByModel: Map<string, number>;
  maxTokensByModel: Map<string, number>;
}

const buildEmptyHybridAIDiscoveryState = (): HybridAIDiscoveryState => ({
  discoveredModelNames: [],
  contextWindowByModel: new Map(),
  maxTokensByModel: new Map(),
});

export function createHybridAIDiscoveryStore(): HybridAIDiscoveryStore {
  const discoveryStore = createDiscoveryStore(
    buildEmptyHybridAIDiscoveryState(),
  );

  async function fetchHybridAIModels(
    apiKey: string,
  ): Promise<HybridAIDiscoveryState> {
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
    const maxTokens = new Map<string, number>();

    for (const entry of getDiscoveryEntries(payload)) {
      if (!isRecord(entry)) continue;
      const normalized = readModelId(entry);
      if (!normalized) continue;
      discovered.add(normalized);
      const contextWindow = readHybridAIContextWindow(entry);
      if (contextWindow != null) {
        contextWindows.set(normalized, contextWindow);
      }
      const modelMaxTokens =
        readPositiveInteger(entry.maxTokens) ??
        readPositiveInteger(entry.max_tokens) ??
        readPositiveInteger(entry.maxOutputTokens) ??
        readPositiveInteger(entry.max_output_tokens) ??
        readPositiveInteger(entry.maxCompletionTokens) ??
        readPositiveInteger(entry.max_completion_tokens);
      if (modelMaxTokens != null) {
        maxTokens.set(normalized, modelMaxTokens);
      }
    }

    return {
      discoveredModelNames: [...discovered],
      contextWindowByModel: contextWindows,
      maxTokensByModel: maxTokens,
    };
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
        discoveryStore.replaceState(buildEmptyHybridAIDiscoveryState(), {
          cacheResult: false,
        });
        return [];
      }
      throw error;
    }

    const state = await discoveryStore.discover(
      () => fetchHybridAIModels(apiKey),
      {
        force: opts?.force,
        onError: (err, staleState) => {
          logger.warn({ err }, 'HybridAI model discovery failed');
          return staleState;
        },
      },
    );
    return [...state.discoveredModelNames];
  }

  return {
    discoverModels,
    getModelNames: () => [...discoveryStore.getState().discoveredModelNames],
    getModelContextWindow: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = resolveCachedHybridAIModelKey(
        model,
        state.contextWindowByModel.keys(),
      );
      return state.contextWindowByModel.get(normalized) ?? null;
    },
    getModelMaxTokens: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = resolveCachedHybridAIModelKey(
        model,
        state.maxTokensByModel.keys(),
      );
      return state.maxTokensByModel.get(normalized) ?? null;
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

export function getDiscoveredHybridAIModelMaxTokens(
  model: string,
): number | null {
  return defaultHybridAIDiscoveryStore.getModelMaxTokens(model);
}
