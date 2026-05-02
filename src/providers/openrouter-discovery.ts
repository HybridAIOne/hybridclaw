import { OPENROUTER_BASE_URL, OPENROUTER_ENABLED } from '../config/config.js';
import { logger } from '../logger.js';
import { readApiKeyForOpenAICompatProvider } from './openai-compat-remote.js';
import {
  buildOpenRouterAttributionHeaders,
  OPENROUTER_MODEL_PREFIX,
} from './openrouter-utils.js';
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
  const architecture = isRecord(entry.architecture) ? entry.architecture : null;
  if (architecture) {
    const modality = String(architecture.modality || '').toLowerCase();
    // Only the input side indicates whether the model accepts image input.
    const inputSide = modality.includes('->')
      ? (modality.split('->').at(0) ?? '')
      : modality;
    if (inputSide.includes('image')) return true;
  }
  // Some entries expose a top-level capabilities array.
  if (Array.isArray(entry.capabilities)) {
    return entry.capabilities.some(
      (cap: unknown) => typeof cap === 'string' && /vision|image/i.test(cap),
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
  getModelMaxTokens: (model: string) => number | null;
  getModelPricingUsdPerToken: (
    model: string,
  ) => { input: number | null; output: number | null } | null;
  isModelVisionCapable: (model: string) => boolean;
}

interface OpenRouterDiscoveryState {
  discoveredModelNames: string[];
  freeModelNames: Set<string>;
  contextWindowByModel: Map<string, number>;
  maxTokensByModel: Map<string, number>;
  pricingByModel: Map<string, DiscoveredModelPricingUsdPerToken>;
  visionCapableModels: Set<string>;
}

const buildEmptyOpenRouterDiscoveryState = (): OpenRouterDiscoveryState => ({
  discoveredModelNames: [],
  freeModelNames: new Set(),
  contextWindowByModel: new Map(),
  maxTokensByModel: new Map(),
  pricingByModel: new Map(),
  visionCapableModels: new Set(),
});

export function createOpenRouterDiscoveryStore(): OpenRouterDiscoveryStore {
  const discoveryStore = createDiscoveryStore(
    buildEmptyOpenRouterDiscoveryState(),
  );

  async function fetchOpenRouterModels(
    apiKey: string,
  ): Promise<OpenRouterDiscoveryState> {
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
    const maxTokens = new Map<string, number>();
    const pricingByModel = new Map<string, DiscoveredModelPricingUsdPerToken>();
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
        const topProvider = isRecord(entry.top_provider)
          ? entry.top_provider
          : null;
        const modelMaxTokens =
          readPositiveInteger(entry.maxTokens) ??
          readPositiveInteger(entry.max_tokens) ??
          readPositiveInteger(entry.maxOutputTokens) ??
          readPositiveInteger(entry.max_output_tokens) ??
          readPositiveInteger(entry.maxCompletionTokens) ??
          readPositiveInteger(entry.max_completion_tokens) ??
          readPositiveInteger(topProvider?.maxTokens) ??
          readPositiveInteger(topProvider?.max_tokens) ??
          readPositiveInteger(topProvider?.maxOutputTokens) ??
          readPositiveInteger(topProvider?.max_output_tokens) ??
          readPositiveInteger(topProvider?.maxCompletionTokens) ??
          readPositiveInteger(topProvider?.max_completion_tokens);
        if (modelMaxTokens != null) {
          maxTokens.set(normalized, modelMaxTokens);
        }
        const pricing = readDiscoveredModelPricingUsdPerToken(entry);
        if (pricing) {
          pricingByModel.set(normalized, pricing);
        }
        if (isFreeOpenRouterModel(entry)) {
          freeDiscovered.add(normalized);
        }
        if (isVisionCapableOpenRouterModel(entry)) {
          visionCapable.add(normalized);
        }
      }
    }
    return {
      discoveredModelNames: [...discovered],
      freeModelNames: freeDiscovered,
      contextWindowByModel: contextWindows,
      maxTokensByModel: maxTokens,
      pricingByModel,
      visionCapableModels: visionCapable,
    };
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!OPENROUTER_ENABLED) {
      discoveryStore.replaceState(buildEmptyOpenRouterDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const apiKey = readApiKeyForOpenAICompatProvider('openrouter', {
      required: false,
    });
    if (!apiKey) {
      discoveryStore.replaceState(buildEmptyOpenRouterDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const state = await discoveryStore.discover(
      () => fetchOpenRouterModels(apiKey),
      {
        force: opts?.force,
        onError: (err, staleState) => {
          logger.warn({ err }, 'OpenRouter model discovery failed');
          return staleState;
        },
      },
    );
    return [...state.discoveredModelNames];
  }

  return {
    discoverModels,
    getModelNames: () => [...discoveryStore.getState().discoveredModelNames],
    isModelFree: (model: string) => {
      const normalized = normalizeOpenRouterModelName(model);
      return discoveryStore.getState().freeModelNames.has(normalized);
    },
    getModelContextWindow: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeOpenRouterModelName(model);
      return state.contextWindowByModel.get(normalized) ?? null;
    },
    getModelMaxTokens: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeOpenRouterModelName(model);
      return state.maxTokensByModel.get(normalized) ?? null;
    },
    getModelPricingUsdPerToken: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeOpenRouterModelName(model);
      return state.pricingByModel.get(normalized) ?? null;
    },
    isModelVisionCapable: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeOpenRouterModelName(model);
      return state.visionCapableModels.has(normalized);
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

export function getDiscoveredOpenRouterModelMaxTokens(
  model: string,
): number | null {
  return defaultOpenRouterDiscoveryStore.getModelMaxTokens(model);
}

export function getDiscoveredOpenRouterModelPricingUsdPerToken(
  model: string,
): { input: number | null; output: number | null } | null {
  return defaultOpenRouterDiscoveryStore.getModelPricingUsdPerToken(model);
}

export function isDiscoveredOpenRouterModelVisionCapable(
  model: string,
): boolean {
  return defaultOpenRouterDiscoveryStore.isModelVisionCapable(model);
}
