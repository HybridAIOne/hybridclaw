import { HUGGINGFACE_BASE_URL, HUGGINGFACE_ENABLED } from '../config/config.js';
import { logger } from '../logger.js';
import { HUGGINGFACE_MODEL_PREFIX } from './huggingface-utils.js';
import { readApiKeyForOpenAICompatProvider } from './openai-compat-remote.js';
import { isRecord, normalizeBaseUrl, readPositiveInteger } from './utils.js';

const HUGGINGFACE_DISCOVERY_TTL_MS = 3_600_000;

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
}

export function createHuggingFaceDiscoveryStore(): HuggingFaceDiscoveryStore {
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

  async function fetchHuggingFaceModels(apiKey: string): Promise<string[]> {
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
    for (const entry of data) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue;
      const normalized = normalizeHuggingFaceModelName(entry.id);
      if (!normalized) continue;
      discovered.add(normalized);
      const contextWindow = readHuggingFaceContextWindow(entry);
      if (contextWindow != null) {
        contextWindows.set(normalized, contextWindow);
      }
    }
    replaceDiscoveryCache([...discovered], contextWindows);
    return [...discovered];
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!HUGGINGFACE_ENABLED) {
      replaceDiscoveryCache([], [], { cacheResult: false });
      return [];
    }

    const apiKey = readApiKeyForOpenAICompatProvider('huggingface', {
      required: false,
    });
    if (!apiKey) {
      replaceDiscoveryCache([], [], { cacheResult: false });
      return [];
    }

    const cacheAgeMs = Date.now() - discoveredAtMs;
    if (
      !opts?.force &&
      discoveredAtMs > 0 &&
      cacheAgeMs < HUGGINGFACE_DISCOVERY_TTL_MS
    ) {
      return [...discoveredModelNames];
    }

    if (discoveryInFlight) return discoveryInFlight;
    const stale = [...discoveredModelNames];

    discoveryInFlight = (async () => {
      try {
        await fetchHuggingFaceModels(apiKey);
        return [...discoveredModelNames];
      } catch (err) {
        logger.warn({ err }, 'HuggingFace model discovery failed');
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
      const normalized = normalizeHuggingFaceModelName(model);
      return contextWindowByModel.get(normalized) ?? null;
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
