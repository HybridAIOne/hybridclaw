import { MISTRAL_BASE_URL, MISTRAL_ENABLED } from '../config/config.js';
import { logger } from '../logger.js';
import { normalizeMistralModelName } from './mistral-utils.js';
import { readApiKeyForOpenAICompatProvider } from './openai-compat-remote.js';
import { isRecord, normalizeBaseUrl, readPositiveInteger } from './utils.js';

const MISTRAL_DISCOVERY_TTL_MS = 3_600_000;

function readMistralModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  return [];
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

function isDeprecatedMistralModelEntry(
  entry: Record<string, unknown>,
): boolean {
  // Mistral's current `/v1/models` response example documents both fields.
  return Boolean(entry.deprecation) || entry.archived === true;
}

export interface MistralDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  getModelContextWindow: (model: string) => number | null;
  resolveCanonicalModelName: (model: string) => string;
  isModelVisionCapable: (model: string) => boolean;
  isModelDeprecated: (model: string) => boolean;
}

export function createMistralDiscoveryStore(): MistralDiscoveryStore {
  let canonicalModelByName = new Map<string, string>();
  let discoveredModelNames: string[] = [];
  let contextWindowByModel = new Map<string, number>();
  let deprecatedModelNames = new Set<string>();
  let visionCapableModels = new Set<string>();
  let discoveredAtMs = 0;
  let discoveryInFlight: Promise<string[]> | null = null;

  function replaceDiscoveryCache(
    modelNames: string[],
    nextCanonicalModelByName: Iterable<[string, string]> = [],
    nextContextWindows: Iterable<[string, number]> = [],
    nextDeprecatedModels: Iterable<string> = [],
    nextVisionCapable: Iterable<string> = [],
    opts?: { cacheResult?: boolean },
  ): void {
    canonicalModelByName = new Map(nextCanonicalModelByName);
    discoveredModelNames = [...modelNames];
    contextWindowByModel = new Map(nextContextWindows);
    deprecatedModelNames = new Set(nextDeprecatedModels);
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
    const canonicalByName = new Map<string, string>();
    const discovered = new Set<string>();
    const contextWindows = new Map<string, number>();
    const deprecated = new Set<string>();
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
      if (isDeprecatedMistralModelEntry(entry)) {
        deprecated.add(canonical);
        continue;
      }
      discovered.add(canonical);
      const contextWindow = readMistralContextWindow(entry);
      if (contextWindow != null) {
        contextWindows.set(canonical, contextWindow);
      }
      if (isVisionCapableMistralModel(entry)) {
        visionCapable.add(canonical);
      }
    }
    replaceDiscoveryCache(
      [...discovered],
      canonicalByName,
      contextWindows,
      deprecated,
      visionCapable,
    );
    return [...discovered];
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!MISTRAL_ENABLED) {
      replaceDiscoveryCache([], [], [], [], [], { cacheResult: false });
      return [];
    }

    const apiKey = readApiKeyForOpenAICompatProvider('mistral', {
      required: false,
    });
    if (!apiKey) {
      replaceDiscoveryCache([], [], [], [], [], { cacheResult: false });
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
      const canonical = canonicalModelByName.get(normalized) ?? normalized;
      return contextWindowByModel.get(canonical) ?? null;
    },
    resolveCanonicalModelName: (model: string) => {
      const normalized = normalizeMistralModelName(model);
      return canonicalModelByName.get(normalized) ?? normalized;
    },
    isModelDeprecated: (model: string) =>
      deprecatedModelNames.has(
        canonicalModelByName.get(normalizeMistralModelName(model)) ??
          normalizeMistralModelName(model),
      ),
    isModelVisionCapable: (model: string) =>
      visionCapableModels.has(
        canonicalModelByName.get(normalizeMistralModelName(model)) ??
          normalizeMistralModelName(model),
      ),
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

export function resolveDiscoveredMistralModelCanonicalName(
  model: string,
): string {
  return defaultMistralDiscoveryStore.resolveCanonicalModelName(model);
}

export function isDiscoveredDeprecatedMistralModel(model: string): boolean {
  return defaultMistralDiscoveryStore.isModelDeprecated(model);
}

export function isDiscoveredMistralModelVisionCapable(model: string): boolean {
  return defaultMistralDiscoveryStore.isModelVisionCapable(model);
}
