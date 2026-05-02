import {
  requireAnthropicApiKey,
  requireAnthropicClaudeCliCredential,
} from '../auth/anthropic-auth.js';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_ENABLED,
  ANTHROPIC_METHOD,
} from '../config/config.js';
import { logger } from '../logger.js';
import {
  buildAnthropicSupportingHeaders,
  isAnthropicOAuthToken,
  normalizeAnthropicBaseUrl,
  normalizeAnthropicModelName,
} from './anthropic-utils.js';
import {
  type DiscoveredModelPricingUsdPerToken,
  readDiscoveredModelPricingUsdPerToken,
} from './pricing-discovery.js';
import {
  createDiscoveryStore,
  isRecord,
  readPositiveInteger,
} from './utils.js';

export interface AnthropicDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  getModelContextWindow: (model: string) => number | null;
  getModelMaxTokens: (model: string) => number | null;
  getModelPricingUsdPerToken: (
    model: string,
  ) => DiscoveredModelPricingUsdPerToken | null;
  isModelVisionCapable: (model: string) => boolean;
}

interface AnthropicDiscoveryState {
  discoveredModelNames: string[];
  contextWindowByModel: Map<string, number>;
  maxTokensByModel: Map<string, number>;
  pricingByModel: Map<string, DiscoveredModelPricingUsdPerToken>;
  visionCapableModels: Set<string>;
}

const buildEmptyAnthropicDiscoveryState = (): AnthropicDiscoveryState => ({
  discoveredModelNames: [],
  contextWindowByModel: new Map(),
  maxTokensByModel: new Map(),
  pricingByModel: new Map(),
  visionCapableModels: new Set(),
});

function resolveAnthropicModelDiscoveryHeaders(): Record<
  string,
  string
> | null {
  try {
    if (ANTHROPIC_METHOD === 'claude-cli') {
      const credential = requireAnthropicClaudeCliCredential();
      const token =
        credential.type === 'oauth' ? credential.accessToken : credential.token;
      return {
        Authorization: `Bearer ${token}`,
        ...buildAnthropicSupportingHeaders({ apiKey: token }),
      };
    }

    const auth = requireAnthropicApiKey();
    const headers = { ...auth.headers };
    if (isAnthropicOAuthToken(auth.apiKey)) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
      delete headers['x-api-key'];
    } else {
      headers['x-api-key'] = auth.apiKey;
      delete headers.Authorization;
    }
    return headers;
  } catch {
    return null;
  }
}

function readAnthropicModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  return [];
}

function readNextPageCursor(payload: unknown): string | null {
  if (!isRecord(payload) || payload.has_more !== true) return null;
  return typeof payload.last_id === 'string' && payload.last_id.trim()
    ? payload.last_id.trim()
    : null;
}

function isVisionCapableAnthropicModel(
  entry: Record<string, unknown>,
): boolean {
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : null;
  if (!capabilities) return false;
  const vision = capabilities.vision ?? capabilities.image;
  if (isRecord(vision)) return vision.supported === true;
  return vision === true;
}

export function createAnthropicDiscoveryStore(): AnthropicDiscoveryStore {
  const discoveryStore = createDiscoveryStore(
    buildEmptyAnthropicDiscoveryState(),
  );

  async function fetchAnthropicModels(
    headers: Record<string, string>,
  ): Promise<AnthropicDiscoveryState> {
    const discovered = new Set<string>();
    const contextWindows = new Map<string, number>();
    const maxTokens = new Map<string, number>();
    const pricingByModel = new Map<string, DiscoveredModelPricingUsdPerToken>();
    const visionCapable = new Set<string>();
    let afterId: string | null = null;

    do {
      const url = new URL(
        `${normalizeAnthropicBaseUrl(ANTHROPIC_BASE_URL)}/models`,
      );
      url.searchParams.set('limit', '1000');
      if (afterId) url.searchParams.set('after_id', afterId);
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      for (const entry of readAnthropicModelEntries(payload)) {
        if (!isRecord(entry) || typeof entry.id !== 'string') continue;
        const normalized = normalizeAnthropicModelName(entry.id);
        if (!normalized) continue;
        discovered.add(normalized);

        const contextWindow = readPositiveInteger(entry.max_input_tokens);
        if (contextWindow != null) {
          contextWindows.set(normalized, contextWindow);
        }
        const outputMaxTokens = readPositiveInteger(entry.max_tokens);
        if (outputMaxTokens != null) {
          maxTokens.set(normalized, outputMaxTokens);
        }
        const pricing = readDiscoveredModelPricingUsdPerToken(entry);
        if (pricing) {
          pricingByModel.set(normalized, pricing);
        }
        if (isVisionCapableAnthropicModel(entry)) {
          visionCapable.add(normalized);
        }
      }
      afterId = readNextPageCursor(payload);
    } while (afterId);

    return {
      discoveredModelNames: [...discovered],
      contextWindowByModel: contextWindows,
      maxTokensByModel: maxTokens,
      pricingByModel,
      visionCapableModels: visionCapable,
    };
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!ANTHROPIC_ENABLED) {
      discoveryStore.replaceState(buildEmptyAnthropicDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const headers = resolveAnthropicModelDiscoveryHeaders();
    if (!headers) {
      discoveryStore.replaceState(buildEmptyAnthropicDiscoveryState(), {
        skipCache: true,
      });
      return [];
    }

    const state = await discoveryStore.discover(
      () => fetchAnthropicModels(headers),
      {
        force: opts?.force,
        onError: (err, staleState) => {
          logger.warn({ err }, 'Anthropic model discovery failed');
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
      const normalized = normalizeAnthropicModelName(model);
      return state.contextWindowByModel.get(normalized) ?? null;
    },
    getModelMaxTokens: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeAnthropicModelName(model);
      return state.maxTokensByModel.get(normalized) ?? null;
    },
    getModelPricingUsdPerToken: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeAnthropicModelName(model);
      return state.pricingByModel.get(normalized) ?? null;
    },
    isModelVisionCapable: (model: string) => {
      const state = discoveryStore.getState();
      const normalized = normalizeAnthropicModelName(model);
      return state.visionCapableModels.has(normalized);
    },
  };
}

const defaultAnthropicDiscoveryStore = createAnthropicDiscoveryStore();

export async function discoverAnthropicModels(opts?: {
  force?: boolean;
}): Promise<string[]> {
  return defaultAnthropicDiscoveryStore.discoverModels(opts);
}

export function getDiscoveredAnthropicModelNames(): string[] {
  return defaultAnthropicDiscoveryStore.getModelNames();
}

export function getDiscoveredAnthropicModelContextWindow(
  model: string,
): number | null {
  return defaultAnthropicDiscoveryStore.getModelContextWindow(model);
}

export function getDiscoveredAnthropicModelMaxTokens(
  model: string,
): number | null {
  return defaultAnthropicDiscoveryStore.getModelMaxTokens(model);
}

export function getDiscoveredAnthropicModelPricingUsdPerToken(
  model: string,
): DiscoveredModelPricingUsdPerToken | null {
  return defaultAnthropicDiscoveryStore.getModelPricingUsdPerToken(model);
}

export function isDiscoveredAnthropicModelVisionCapable(
  model: string,
): boolean {
  return defaultAnthropicDiscoveryStore.isModelVisionCapable(model);
}
