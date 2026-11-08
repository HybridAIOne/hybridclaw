/**
 * Keeps provider-reported model metadata, including explicit text-only input.
 * Missing modality stays unknown so callers can negotiate visual delivery;
 * discovery does not grant permission to send pixels or invoke a model.
 */
import { OPENROUTER_BASE_URL, OPENROUTER_ENABLED } from '../config/config.js';
import { logger } from '../logger.js';
import { parsePositiveInteger } from '../utils/number-normalization.js';
import { readApiKeyForOpenAICompatProvider } from './openai-compat-remote.js';
import {
  buildOpenRouterAttributionHeaders,
  OPENROUTER_MODEL_PREFIX,
} from './openrouter-utils.js';
import {
  type DiscoveredModelPricingUsdPerToken,
  readDiscoveredModelPricingUsdPerToken,
} from './pricing-discovery.js';
import { createDiscoveryStore, isRecord, normalizeBaseUrl } from './utils.js';

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
    parsePositiveInteger(entry.context_length) ??
    parsePositiveInteger(entry.contextLength) ??
    parsePositiveInteger(topProvider?.context_length) ??
    parsePositiveInteger(topProvider?.contextLength)
  );
}

function readVisionCapability(entry: Record<string, unknown>): boolean | null {
  const architecture = isRecord(entry.architecture) ? entry.architecture : null;
  let known = false;
  if (architecture) {
    const modality =
      typeof architecture.modality === 'string'
        ? architecture.modality.toLowerCase()
        : '';
    // Only the input side indicates whether the model accepts image input.
    const inputSide = modality.includes('->')
      ? (modality.split('->').at(0) ?? '')
      : modality;
    if (inputSide.includes('image')) return true;
    known = inputSide.trim().length > 0;
    if (Array.isArray(architecture.input_modalities)) {
      const inputs = architecture.input_modalities.filter(
        (input): input is string => typeof input === 'string' && !!input.trim(),
      );
      if (inputs.some((input) => input.trim().toLowerCase() === 'image'))
        return true;
      known ||= inputs.length > 0;
    }
  }
  // Some entries expose a top-level capabilities array.
  if (Array.isArray(entry.capabilities)) {
    if (
      entry.capabilities.some(
        (cap: unknown) => typeof cap === 'string' && /vision|image/i.test(cap),
      )
    )
      return true;
  }
  return known ? false : null;
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
  getModelVisionCapability: (model: string) => boolean | null;
}

interface OpenRouterDiscoveryState {
  discoveredModelNames: string[];
  freeModelNames: Set<string>;
  contextWindowByModel: Map<string, number>;
  maxTokensByModel: Map<string, number>;
  pricingByModel: Map<string, DiscoveredModelPricingUsdPerToken>;
  visionCapabilityByModel: Map<string, boolean>;
}

const buildEmptyOpenRouterDiscoveryState = (): OpenRouterDiscoveryState => ({
  discoveredModelNames: [],
  freeModelNames: new Set(),
  contextWindowByModel: new Map(),
  maxTokensByModel: new Map(),
  pricingByModel: new Map(),
  visionCapabilityByModel: new Map(),
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
    const visionCapabilities = new Map<string, boolean>();
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
          parsePositiveInteger(entry.maxTokens) ??
          parsePositiveInteger(entry.max_tokens) ??
          parsePositiveInteger(entry.maxOutputTokens) ??
          parsePositiveInteger(entry.max_output_tokens) ??
          parsePositiveInteger(entry.maxCompletionTokens) ??
          parsePositiveInteger(entry.max_completion_tokens) ??
          parsePositiveInteger(topProvider?.maxTokens) ??
          parsePositiveInteger(topProvider?.max_tokens) ??
          parsePositiveInteger(topProvider?.maxOutputTokens) ??
          parsePositiveInteger(topProvider?.max_output_tokens) ??
          parsePositiveInteger(topProvider?.maxCompletionTokens) ??
          parsePositiveInteger(topProvider?.max_completion_tokens);
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
        const vision = readVisionCapability(entry);
        if (vision !== null) visionCapabilities.set(normalized, vision);
      }
    }
    return {
      discoveredModelNames: [...discovered],
      freeModelNames: freeDiscovered,
      contextWindowByModel: contextWindows,
      maxTokensByModel: maxTokens,
      pricingByModel,
      visionCapabilityByModel: visionCapabilities,
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
      return state.visionCapabilityByModel.get(normalized) === true;
    },
    getModelVisionCapability: (model: string) => {
      const normalized = normalizeOpenRouterModelName(model);
      return (
        discoveryStore.getState().visionCapabilityByModel.get(normalized) ??
        null
      );
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

export function getDiscoveredOpenRouterModelVisionCapability(
  model: string,
): boolean | null {
  return defaultOpenRouterDiscoveryStore.getModelVisionCapability(model);
}
