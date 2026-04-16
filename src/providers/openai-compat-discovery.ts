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
import {
  OPENAI_COMPAT_REMOTE_PROVIDERS,
  type OpenAICompatRemoteProviderDef,
} from './openai-compat-remote.js';
import type { RuntimeProviderId } from './provider-ids.js';
import { isRecord, normalizeBaseUrl } from './utils.js';

const OPENAI_COMPAT_DISCOVERY_TTL_MS = 3_600_000;
const OPENAI_COMPAT_DISCOVERY_TIMEOUT_MS = 5_000;
const OPENAI_COMPAT_DISCOVERY_PATH = '/models';

/**
 * Per-provider discovery URL overrides for providers whose model list lives at
 * something other than `<baseUrl>/models`. Value may be a fully-qualified URL
 * (host + path) or a path (starting with `/`) resolved against `baseUrl`.
 * Providers not in this map use the default `<baseUrl>/models`.
 *
 * Currently empty — all nine providers' discovery endpoints are reachable at
 * `<baseUrl>/models`. Kept as an extension point.
 */
const DISCOVERY_URL_OVERRIDES: Partial<Record<RuntimeProviderId, string>> = {};

// Per-provider `*_ENABLED` flag readers. Kept local to this module so we don't
// churn `OpenAICompatRemoteProviderDef` (and its 9 registry literals) just to
// carry an enabled-check.
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
  // Other RuntimeProviderIds aren't OpenAI-compat-remote providers handled
  // by this module.
  hybridai: undefined,
  'openai-codex': undefined,
  openrouter: undefined,
  mistral: undefined,
  huggingface: undefined,
  ollama: undefined,
  lmstudio: undefined,
  llamacpp: undefined,
  vllm: undefined,
};

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

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

/**
 * Prepend `prefix` to `id` unless `id` already starts with `prefix`
 * (case-insensitive). Ensures we don't produce `kilo/kilo/...` for providers
 * that already namespace their model ids.
 */
function prefixModelId(prefix: string, id: string): string {
  const lower = id.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lower.startsWith(lowerPrefix)) {
    return id;
  }
  return `${prefix}${id}`;
}

// ---------------------------------------------------------------------------
// Per-provider discovery store
// ---------------------------------------------------------------------------

export interface OpenAICompatDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
}

export function createOpenAICompatDiscoveryStore(
  def: OpenAICompatRemoteProviderDef,
  readEnabled: () => boolean,
): OpenAICompatDiscoveryStore {
  let discoveredModelNames: string[] = [];
  let discoveredAtMs = 0;
  let discoveryInFlight: Promise<string[]> | null = null;

  function replaceCache(
    modelNames: string[],
    opts?: { cacheResult?: boolean },
  ): void {
    discoveredModelNames = [...modelNames];
    discoveredAtMs = opts?.cacheResult === false ? 0 : Date.now();
  }

  function resolveDiscoveryUrl(): string {
    const override = DISCOVERY_URL_OVERRIDES[def.id];
    if (override) {
      // Fully-qualified URL wins. Path-style overrides (leading `/`) are
      // resolved against the provider's baseUrl.
      if (/^https?:\/\//i.test(override)) return override;
      return `${normalizeBaseUrl(def.readBaseUrl())}${override}`;
    }
    return `${normalizeBaseUrl(def.readBaseUrl())}${OPENAI_COMPAT_DISCOVERY_PATH}`;
  }

  async function fetchModels(apiKey: string): Promise<string[]> {
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
    for (const entry of entries) {
      const rawId = readEntryId(entry);
      if (!rawId) continue;
      const prefixed = prefixModelId(def.prefix, rawId);
      if (seen.has(prefixed)) continue;
      seen.add(prefixed);
      discovered.push(prefixed);
    }
    replaceCache(discovered);
    return [...discovered];
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    if (!readEnabled()) {
      replaceCache([], { cacheResult: false });
      return [];
    }

    const apiKey = def.readApiKey({ required: false });
    if (!apiKey) {
      replaceCache([], { cacheResult: false });
      return [];
    }

    const cacheAgeMs = Date.now() - discoveredAtMs;
    if (
      !opts?.force &&
      discoveredAtMs > 0 &&
      cacheAgeMs < OPENAI_COMPAT_DISCOVERY_TTL_MS
    ) {
      return [...discoveredModelNames];
    }

    if (discoveryInFlight) return discoveryInFlight;
    const stale = [...discoveredModelNames];

    discoveryInFlight = (async () => {
      try {
        await fetchModels(apiKey);
        return [...discoveredModelNames];
      } catch (err) {
        // Treat "endpoint absent" responses (404 / 405) as a routine
        // provider-doesn't-implement-/v1/models condition — log at debug so
        // users aren't paged by the noise. Everything else (network errors,
        // 5xx, 401/403) stays at warn.
        const httpStatus = (err as { httpStatus?: number } | null)?.httpStatus;
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
  };
}

// ---------------------------------------------------------------------------
// Registry of per-provider stores
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
  return all;
}
