import {
  DASHSCOPE_ENABLED,
  DEEPSEEK_ENABLED,
  GEMINI_ENABLED,
  KILO_ENABLED,
  KIMI_ENABLED,
  MINIMAX_ENABLED,
  XAI_ENABLED,
  XIAOMI_ENABLED,
  ZAI_ENABLED,
} from '../config/config.js';
import { logger } from '../logger.js';
import { getDiscoveredHuggingFaceModelNames } from './huggingface-discovery.js';
import { getDiscoveredMistralModelNames } from './mistral-discovery.js';
import {
  OPENAI_COMPAT_REMOTE_PROVIDERS,
  type OpenAICompatRemoteProviderDef,
} from './openai-compat-remote.js';
import { getDiscoveredOpenRouterModelNames } from './openrouter-discovery.js';
import {
  type DiscoveredModelPricingUsdPerToken,
  readDiscoveredModelPricingUsdPerToken,
} from './pricing-discovery.js';
import type { RuntimeProviderId } from './provider-ids.js';
import { createDiscoveryStore, isRecord, normalizeBaseUrl } from './utils.js';

const OPENAI_COMPAT_DISCOVERY_TIMEOUT_MS = 5_000;
const OPENAI_COMPAT_DISCOVERY_PATH = '/models';

const DISCOVERY_URL_OVERRIDES: Partial<Record<RuntimeProviderId, string>> = {};

const ENABLED_BY_ID: Record<RuntimeProviderId, (() => boolean) | undefined> = {
  gemini: () => GEMINI_ENABLED,
  deepseek: () => DEEPSEEK_ENABLED,
  xai: () => XAI_ENABLED,
  zai: () => ZAI_ENABLED,
  kimi: () => KIMI_ENABLED,
  minimax: () => MINIMAX_ENABLED,
  dashscope: () => DASHSCOPE_ENABLED,
  xiaomi: () => XIAOMI_ENABLED,
  kilo: () => KILO_ENABLED,
  hybridai: undefined,
  'openai-codex': undefined,
  anthropic: undefined,
  openrouter: undefined,
  mistral: undefined,
  huggingface: undefined,
  ollama: undefined,
  lmstudio: undefined,
  llamacpp: undefined,
  vllm: undefined,
};

function readModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.models)) return payload.models;
  }
  return [];
}

function readEntryId(entry: unknown): string {
  if (!isRecord(entry)) return '';
  const id = entry.id;
  if (typeof id !== 'string') return '';
  return id.trim();
}

function prefixModelId(prefix: string, id: string): string {
  const lower = id.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lower.startsWith(lowerPrefix)) {
    return id;
  }
  return `${prefix}${id}`;
}

export interface DiscoveryError {
  httpStatus?: number;
  message: string;
}

export interface OpenAICompatDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  getModelPricingUsdPerToken: (
    model: string,
  ) => DiscoveredModelPricingUsdPerToken | null;
  getLastError: () => DiscoveryError | null;
}

interface OpenAICompatDiscoveryState {
  discoveredModelNames: string[];
  pricingByModel: Map<string, DiscoveredModelPricingUsdPerToken>;
}

const buildEmptyOpenAICompatDiscoveryState =
  (): OpenAICompatDiscoveryState => ({
    discoveredModelNames: [],
    pricingByModel: new Map(),
  });

export function createOpenAICompatDiscoveryStore(
  def: OpenAICompatRemoteProviderDef,
  readEnabled: () => boolean,
): OpenAICompatDiscoveryStore {
  const discoveryStore = createDiscoveryStore(
    buildEmptyOpenAICompatDiscoveryState(),
  );
  let lastError: DiscoveryError | null = null;

  function resolveDiscoveryUrl(): string {
    const override = DISCOVERY_URL_OVERRIDES[def.id];
    if (override) {
      if (/^https?:\/\//i.test(override)) return override;
      return `${normalizeBaseUrl(def.readBaseUrl())}${override}`;
    }
    return `${normalizeBaseUrl(def.readBaseUrl())}${OPENAI_COMPAT_DISCOVERY_PATH}`;
  }

  async function fetchModels(
    apiKey: string,
  ): Promise<OpenAICompatDiscoveryState> {
    const url = resolveDiscoveryUrl();
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(OPENAI_COMPAT_DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`) as Error & {
        httpStatus?: number;
      };
      err.httpStatus = response.status;
      throw err;
    }

    const payload = (await response.json()) as unknown;
    const entries = readModelEntries(payload);
    const seen = new Set<string>();
    const discovered: string[] = [];
    const pricingByModel = new Map<string, DiscoveredModelPricingUsdPerToken>();
    for (const entry of entries) {
      const rawId = readEntryId(entry);
      if (!rawId) continue;
      const prefixed = prefixModelId(def.prefix, rawId);
      if (seen.has(prefixed)) continue;
      seen.add(prefixed);
      discovered.push(prefixed);
      if (isRecord(entry)) {
        const pricing = readDiscoveredModelPricingUsdPerToken(entry);
        if (pricing) pricingByModel.set(prefixed, pricing);
      }
    }
    lastError = null;
    return { discoveredModelNames: discovered, pricingByModel };
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!readEnabled()) {
      discoveryStore.replaceState(buildEmptyOpenAICompatDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const apiKey = def.readApiKey({ required: false });
    if (!apiKey) {
      discoveryStore.replaceState(buildEmptyOpenAICompatDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const state = await discoveryStore.discover(() => fetchModels(apiKey), {
      force: opts?.force,
      onError: (err, staleState) => {
        const httpStatus = (err as { httpStatus?: number } | null)?.httpStatus;
        const message = err instanceof Error ? err.message : String(err);
        lastError = { httpStatus, message };
        if (httpStatus === 404 || httpStatus === 405) {
          logger.debug(
            { err, provider: def.id, httpStatus },
            'OpenAI-compat model discovery not supported by provider',
          );
        } else {
          logger.warn(
            { err, provider: def.id },
            'OpenAI-compat model discovery failed',
          );
        }
        return staleState;
      },
    });
    return [...state.discoveredModelNames];
  }

  return {
    discoverModels,
    getModelNames: () => [...discoveryStore.getState().discoveredModelNames],
    getModelPricingUsdPerToken: (model: string) => {
      const normalized = prefixModelId(def.prefix, model);
      return discoveryStore.getState().pricingByModel.get(normalized) ?? null;
    },
    getLastError: () => (lastError ? { ...lastError } : null),
  };
}

function buildStoreRegistry(): ReadonlyMap<
  RuntimeProviderId,
  OpenAICompatDiscoveryStore
> {
  const map = new Map<RuntimeProviderId, OpenAICompatDiscoveryStore>();
  for (const def of OPENAI_COMPAT_REMOTE_PROVIDERS) {
    const readEnabled = ENABLED_BY_ID[def.id];
    if (!readEnabled) continue;
    map.set(def.id, createOpenAICompatDiscoveryStore(def, readEnabled));
  }
  return map;
}

const defaultStoreRegistry = buildStoreRegistry();

export async function discoverOpenAICompatRemoteModels(opts?: {
  force?: boolean;
}): Promise<void> {
  await Promise.allSettled(
    Array.from(defaultStoreRegistry.values(), (store) =>
      store.discoverModels(opts),
    ),
  );
}

export function getDiscoveredOpenAICompatRemoteModelNames(): string[] {
  const all: string[] = [];
  for (const store of defaultStoreRegistry.values()) {
    all.push(...store.getModelNames());
  }
  all.push(...getDiscoveredOpenRouterModelNames());
  all.push(...getDiscoveredMistralModelNames());
  all.push(...getDiscoveredHuggingFaceModelNames());
  return all;
}

export function getDiscoveredOpenAICompatRemoteModelPricingUsdPerToken(
  model: string,
): DiscoveredModelPricingUsdPerToken | null {
  for (const store of defaultStoreRegistry.values()) {
    const pricing = store.getModelPricingUsdPerToken(model);
    if (pricing) return pricing;
  }
  return null;
}

export function getOpenAICompatProviderLastError(
  id: RuntimeProviderId,
): DiscoveryError | null {
  return defaultStoreRegistry.get(id)?.getLastError() ?? null;
}
