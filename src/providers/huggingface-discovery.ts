import { HUGGINGFACE_BASE_URL, HUGGINGFACE_ENABLED } from '../config/config.js';
import { logger } from '../logger.js';
import { HUGGINGFACE_MODEL_PREFIX } from './huggingface-utils.js';
import { readApiKeyForOpenAICompatProvider } from './openai-compat-remote.js';
import {
  type DiscoveredModelPricingUsdPerToken,
  readDiscoveredModelPricingUsdPerToken,
} from './pricing-discovery.js';
import {
  createDiscoveryStore,
  isRecord,
  normalizeBaseUrl,
  readPositiveInteger,
} from './utils.js';

function normalizeHuggingFaceModelName(modelId: string): string {
  const normalized = String(modelId || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(HUGGINGFACE_MODEL_PREFIX)) {
    return normalized;
  }
  return `${HUGGINGFACE_MODEL_PREFIX}${normalized}`;
}

function readHuggingFaceContextWindow(
  entry: Record<string, unknown>,
): number | null {
  // Observed on Hugging Face Router `/v1/models` on 2026-03-28:
  // - top-level `context_length`
  // - nested `providers[].context_length`
  // Keep parsing limited to the fields we have actually seen.
  const providers = Array.isArray(entry.providers) ? entry.providers : [];
  for (const provider of providers) {
    if (!isRecord(provider)) continue;
    const contextWindow = readPositiveInteger(provider.context_length);
    if (contextWindow != null) {
      return contextWindow;
    }
  }
  return readPositiveInteger(entry.context_length);
}

export interface HuggingFaceDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  getModelContextWindow: (model: string) => number | null;
  getModelPricingUsdPerToken: (
    model: string,
  ) => DiscoveredModelPricingUsdPerToken | null;
}

interface HuggingFaceDiscoveryState {
  discoveredModelNames: string[];
  contextWindowByModel: Map<string, number>;
  pricingByModel: Map<string, DiscoveredModelPricingUsdPerToken>;
}

const buildEmptyHuggingFaceDiscoveryState = (): HuggingFaceDiscoveryState => ({
  discoveredModelNames: [],
  contextWindowByModel: new Map(),
  pricingByModel: new Map(),
});

export function createHuggingFaceDiscoveryStore(): HuggingFaceDiscoveryStore {
  const discoveryStore = createDiscoveryStore(
    buildEmptyHuggingFaceDiscoveryState(),
  );

  async function fetchHuggingFaceModels(
    apiKey: string,
  ): Promise<HuggingFaceDiscoveryState> {
    const response = await fetch(
      `${normalizeBaseUrl(HUGGINGFACE_BASE_URL)}/models`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
    const contextWindows = new Map<string, number>();
    const pricingByModel = new Map<string, DiscoveredModelPricingUsdPerToken>();
    for (const entry of data) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue;
      const normalized = normalizeHuggingFaceModelName(entry.id);
      if (!normalized) continue;
      discovered.add(normalized);
      const contextWindow = readHuggingFaceContextWindow(entry);
      if (contextWindow != null) {
        contextWindows.set(normalized, contextWindow);
      }
      const pricing =
        readDiscoveredModelPricingUsdPerToken(entry) ??
        (Array.isArray(entry.providers)
          ? entry.providers
              .filter(isRecord)
              .map(readDiscoveredModelPricingUsdPerToken)
              .find((value) => value != null)
          : null);
      if (pricing) {
        pricingByModel.set(normalized, pricing);
      }
    }
    return {
      discoveredModelNames: [...discovered],
      contextWindowByModel: contextWindows,
      pricingByModel,
    };
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!HUGGINGFACE_ENABLED) {
      discoveryStore.replaceState(buildEmptyHuggingFaceDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const apiKey = readApiKeyForOpenAICompatProvider('huggingface', {
      required: false,
    });
    if (!apiKey) {
      discoveryStore.replaceState(buildEmptyHuggingFaceDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const state = await discoveryStore.discover(
      () => fetchHuggingFaceModels(apiKey),
      {
        force: opts?.force,
        onError: (err, staleState) => {
          logger.warn({ err }, 'HuggingFace model discovery failed');
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
      const normalized = normalizeHuggingFaceModelName(model);
      return state.contextWindowByModel.get(normalized) ?? null;
    },
    getModelPricingUsdPerToken: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeHuggingFaceModelName(model);
      return state.pricingByModel.get(normalized) ?? null;
    },
  };
}

const defaultHuggingFaceDiscoveryStore = createHuggingFaceDiscoveryStore();

export async function discoverHuggingFaceModels(opts?: {
  force?: boolean;
}): Promise<string[]> {
  return defaultHuggingFaceDiscoveryStore.discoverModels(opts);
}

export function getDiscoveredHuggingFaceModelNames(): string[] {
  return defaultHuggingFaceDiscoveryStore.getModelNames();
}

export function getDiscoveredHuggingFaceModelContextWindow(
  model: string,
): number | null {
  return defaultHuggingFaceDiscoveryStore.getModelContextWindow(model);
}

export function getDiscoveredHuggingFaceModelPricingUsdPerToken(
  model: string,
): DiscoveredModelPricingUsdPerToken | null {
  return defaultHuggingFaceDiscoveryStore.getModelPricingUsdPerToken(model);
}
