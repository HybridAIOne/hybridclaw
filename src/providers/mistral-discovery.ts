/**
 * Mistral discovery distinguishes a cached text-only model from missing metadata.
 * Capability reads describe the catalog; they neither probe nor authorize inference.
 */
import { MISTRAL_BASE_URL, MISTRAL_ENABLED } from '../config/config.js';
import { logger } from '../logger.js';
import { parsePositiveInteger } from '../utils/number-normalization.js';
import { normalizeMistralModelName } from './mistral-utils.js';
import { type ModelLifecycle, readListedModelStatus } from './model-status.js';
import { readApiKeyForOpenAICompatProvider } from './openai-compat-remote.js';
import {
  type DiscoveredModelPricingUsdPerToken,
  readDiscoveredModelPricingUsdPerToken,
} from './pricing-discovery.js';
import { createDiscoveryStore, isRecord, normalizeBaseUrl } from './utils.js';

function readMistralModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  return [];
}

function readMistralContextWindow(
  entry: Record<string, unknown>,
): number | null {
  return parsePositiveInteger(entry.max_context_length);
}

function isVisionCapableMistralModel(entry: Record<string, unknown>): boolean {
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : null;
  return capabilities?.vision === true;
}

function readMistralModelAliases(entry: Record<string, unknown>): string[] {
  if (!Array.isArray(entry.aliases)) return [];
  const aliases: string[] = [];
  for (const alias of entry.aliases) {
    if (typeof alias !== 'string') continue;
    const normalized = normalizeMistralModelName(alias);
    if (!normalized) continue;
    aliases.push(normalized);
  }
  return aliases;
}

function readCanonicalMistralModelName(
  entry: Record<string, unknown>,
  modelId: string,
  aliases: string[],
): string {
  const namedModel =
    typeof entry.name === 'string' ? normalizeMistralModelName(entry.name) : '';
  if (namedModel && namedModel !== modelId) return namedModel;
  if (aliases.length === 0) return modelId;
  return namedModel || modelId;
}

export interface MistralDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  getModelContextWindow: (model: string) => number | null;
  getModelPricingUsdPerToken: (
    model: string,
  ) => DiscoveredModelPricingUsdPerToken | null;
  resolveCanonicalModelName: (model: string) => string;
  isModelVisionCapable: (model: string) => boolean;
  getModelLifecycle: (model: string) => ModelLifecycle | null;
}

interface MistralDiscoveryState {
  canonicalModelByName: Map<string, string>;
  discoveredModelNames: string[];
  contextWindowByModel: Map<string, number>;
  pricingByModel: Map<string, DiscoveredModelPricingUsdPerToken>;
  legacyModelByName: Map<string, ModelLifecycle>;
  visionCapableModels: Set<string>;
}

const buildEmptyMistralDiscoveryState = (): MistralDiscoveryState => ({
  canonicalModelByName: new Map(),
  discoveredModelNames: [],
  contextWindowByModel: new Map(),
  pricingByModel: new Map(),
  legacyModelByName: new Map(),
  visionCapableModels: new Set(),
});

export function createMistralDiscoveryStore(): MistralDiscoveryStore {
  const discoveryStore = createDiscoveryStore(
    buildEmptyMistralDiscoveryState(),
  );

  async function fetchMistralModels(
    apiKey: string,
  ): Promise<MistralDiscoveryState> {
    const response = await fetch(
      `${normalizeBaseUrl(MISTRAL_BASE_URL)}/models`,
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
    const data = readMistralModelEntries(payload);
    const canonicalByName = new Map<string, string>();
    const discovered = new Set<string>();
    const contextWindows = new Map<string, number>();
    const pricingByModel = new Map<string, DiscoveredModelPricingUsdPerToken>();
    const legacy = new Map<string, ModelLifecycle>();
    const visionCapable = new Set<string>();
    for (const entry of data) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue;
      const normalized = normalizeMistralModelName(entry.id);
      if (!normalized) continue;
      const aliases = readMistralModelAliases(entry);
      const canonical = readCanonicalMistralModelName(
        entry,
        normalized,
        aliases,
      );
      canonicalByName.set(normalized, canonical);
      canonicalByName.set(canonical, canonical);
      for (const alias of aliases) {
        canonicalByName.set(alias, canonical);
      }
      const status = readListedModelStatus(entry);
      if (status === 'retired') continue;
      if (status.status === 'legacy') legacy.set(canonical, status);
      discovered.add(canonical);
      const contextWindow = readMistralContextWindow(entry);
      if (contextWindow != null) {
        contextWindows.set(canonical, contextWindow);
      }
      const pricing = readDiscoveredModelPricingUsdPerToken(entry);
      if (pricing) {
        pricingByModel.set(canonical, pricing);
      }
      if (isVisionCapableMistralModel(entry)) {
        visionCapable.add(canonical);
      }
    }
    for (const [model, lifecycle] of legacy) {
      if (!lifecycle.replacement) continue;
      const replacement = normalizeMistralModelName(lifecycle.replacement);
      legacy.set(model, {
        ...lifecycle,
        replacement: canonicalByName.get(replacement) ?? replacement,
      });
    }
    return {
      canonicalModelByName: canonicalByName,
      discoveredModelNames: [...discovered],
      contextWindowByModel: contextWindows,
      pricingByModel,
      legacyModelByName: legacy,
      visionCapableModels: visionCapable,
    };
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!MISTRAL_ENABLED) {
      discoveryStore.replaceState(buildEmptyMistralDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const apiKey = readApiKeyForOpenAICompatProvider('mistral', {
      required: false,
    });
    if (!apiKey) {
      discoveryStore.replaceState(buildEmptyMistralDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const state = await discoveryStore.discover(
      () => fetchMistralModels(apiKey),
      {
        force: opts?.force,
        onError: (err, staleState) => {
          logger.warn({ err }, 'Mistral model discovery failed');
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
      const normalized = normalizeMistralModelName(model);
      const canonical =
        state.canonicalModelByName.get(normalized) ?? normalized;
      return state.contextWindowByModel.get(canonical) ?? null;
    },
    getModelPricingUsdPerToken: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeMistralModelName(model);
      const canonical =
        state.canonicalModelByName.get(normalized) ?? normalized;
      return state.pricingByModel.get(canonical) ?? null;
    },
    resolveCanonicalModelName: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeMistralModelName(model);
      return state.canonicalModelByName.get(normalized) ?? normalized;
    },
    getModelLifecycle: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeMistralModelName(model);
      return (
        state.legacyModelByName.get(
          state.canonicalModelByName.get(normalized) ?? normalized,
        ) ?? null
      );
    },
    isModelVisionCapable: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeMistralModelName(model);
      return state.visionCapableModels.has(
        state.canonicalModelByName.get(normalized) ?? normalized,
      );
    },
  };
}

const defaultMistralDiscoveryStore = createMistralDiscoveryStore();

export async function discoverMistralModels(opts?: {
  force?: boolean;
}): Promise<string[]> {
  return defaultMistralDiscoveryStore.discoverModels(opts);
}

export function getDiscoveredMistralModelNames(): string[] {
  return defaultMistralDiscoveryStore.getModelNames();
}

export function getDiscoveredMistralModelContextWindow(
  model: string,
): number | null {
  return defaultMistralDiscoveryStore.getModelContextWindow(model);
}

export function getDiscoveredMistralModelPricingUsdPerToken(
  model: string,
): DiscoveredModelPricingUsdPerToken | null {
  return defaultMistralDiscoveryStore.getModelPricingUsdPerToken(model);
}

export function resolveDiscoveredMistralModelCanonicalName(
  model: string,
): string {
  return defaultMistralDiscoveryStore.resolveCanonicalModelName(model);
}

export function getDiscoveredMistralModelLifecycle(
  model: string,
): ModelLifecycle | null {
  return defaultMistralDiscoveryStore.getModelLifecycle(model);
}

export function isDiscoveredMistralModelVisionCapable(model: string): boolean {
  return defaultMistralDiscoveryStore.isModelVisionCapable(model);
}

export function getDiscoveredMistralModelVisionCapability(
  model: string,
): boolean | null {
  const canonical =
    defaultMistralDiscoveryStore.resolveCanonicalModelName(model);
  return defaultMistralDiscoveryStore.getModelNames().includes(canonical)
    ? defaultMistralDiscoveryStore.isModelVisionCapable(canonical)
    : null;
}
