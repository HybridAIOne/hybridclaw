import { MISTRAL_BASE_URL, MISTRAL_ENABLED } from '../config/config.js';
import { logger } from '../logger.js';
import {
  isDeprecatedMistralModel,
  normalizeMistralModelName,
  readMistralApiKey,
} from './mistral-utils.js';
import { isRecord, normalizeBaseUrl } from './utils.js';

const MISTRAL_DISCOVERY_TTL_MS = 3_600_000;

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

function readMistralContextWindow(
  entry: Record<string, unknown>,
): number | null {
  return readPositiveInteger(entry.max_context_length);
}

function isVisionCapableMistralModel(entry: Record<string, unknown>): boolean {
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : null;
  return capabilities?.vision === true;
}

function readMistralModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  return [];
}

export interface MistralDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  getModelContextWindow: (model: string) => number | null;
  isModelVisionCapable: (model: string) => boolean;
}

export function createMistralDiscoveryStore(): MistralDiscoveryStore {
  let discoveredModelNames: string[] = [];
  let contextWindowByModel = new Map<string, number>();
  let visionCapableModels = new Set<string>();
  let discoveredAtMs = 0;
  let discoveryInFlight: Promise<string[]> | null = null;

  function replaceDiscoveryCache(
    modelNames: string[],
    nextContextWindows: Iterable<[string, number]> = [],
    nextVisionCapable: Iterable<string> = [],
    opts?: { cacheResult?: boolean },
  ): void {
    discoveredModelNames = [...modelNames];
    contextWindowByModel = new Map(nextContextWindows);
    visionCapableModels = new Set(nextVisionCapable);
    discoveredAtMs = opts?.cacheResult === false ? 0 : Date.now();
  }

  async function fetchMistralModels(apiKey: string): Promise<string[]> {
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
    const discovered = new Set<string>();
    const contextWindows = new Map<string, number>();
    const visionCapable = new Set<string>();
    for (const entry of data) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue;
      const normalized = normalizeMistralModelName(entry.id);
      if (!normalized) continue;
      if (isDeprecatedMistralModel(normalized)) continue;
      discovered.add(normalized);
      const contextWindow = readMistralContextWindow(entry);
      if (contextWindow != null) {
        contextWindows.set(normalized, contextWindow);
      }
      if (isVisionCapableMistralModel(entry)) {
        visionCapable.add(normalized);
      }
    }
    replaceDiscoveryCache([...discovered], contextWindows, visionCapable);
    return [...discovered];
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!MISTRAL_ENABLED) {
      replaceDiscoveryCache([], [], [], { cacheResult: false });
      return [];
    }

    const apiKey = readMistralApiKey({ required: false });
    if (!apiKey) {
      replaceDiscoveryCache([], [], [], { cacheResult: false });
      return [];
    }

    const cacheAgeMs = Date.now() - discoveredAtMs;
    if (
      !opts?.force &&
      discoveredAtMs > 0 &&
      cacheAgeMs < MISTRAL_DISCOVERY_TTL_MS
    ) {
      return [...discoveredModelNames];
    }

    if (discoveryInFlight) return discoveryInFlight;
    const stale = [...discoveredModelNames];

    discoveryInFlight = (async () => {
      try {
        await fetchMistralModels(apiKey);
        return [...discoveredModelNames];
      } catch (err) {
        logger.warn({ err }, 'Mistral model discovery failed');
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
      const normalized = normalizeMistralModelName(model);
      return contextWindowByModel.get(normalized) ?? null;
    },
    isModelVisionCapable: (model: string) =>
      visionCapableModels.has(normalizeMistralModelName(model)),
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

export function isDiscoveredMistralModelVisionCapable(model: string): boolean {
  return defaultMistralDiscoveryStore.isModelVisionCapable(model);
}
