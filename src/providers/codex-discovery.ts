import {
  getCodexAuthStatus,
  resolveCodexCredentials,
} from '../auth/codex-auth.js';
import { CODEX_CLIENT_VERSION } from './codex-constants.js';
import { isRecord, normalizeBaseUrl, readPositiveInteger } from './utils.js';

const CODEX_DISCOVERY_TTL_MS = 3_600_000;
const CODEX_MODEL_PREFIX = 'openai-codex/';
// Keep entries ordered so any model used as a template appears earlier in the
// list than models derived from it. appendForwardCompatCodexModels augments the
// seen set as it walks this table once from top to bottom.
const CODEX_FORWARD_COMPAT_MODELS = [
  {
    model: 'openai-codex/gpt-5.3-codex',
    templateModels: ['openai-codex/gpt-5.2-codex'],
  },
  {
    model: 'openai-codex/gpt-5.4',
    templateModels: [
      'openai-codex/gpt-5.3-codex',
      'openai-codex/gpt-5.2-codex',
    ],
  },
  {
    model: 'openai-codex/gpt-5.4-mini',
    templateModels: [
      'openai-codex/gpt-5.4',
      'openai-codex/gpt-5.1-codex-mini',
      'openai-codex/gpt-5.3-codex',
      'openai-codex/gpt-5.2-codex',
    ],
  },
  {
    model: 'openai-codex/gpt-5.3-codex-spark',
    templateModels: [
      'openai-codex/gpt-5.3-codex',
      'openai-codex/gpt-5.2-codex',
    ],
  },
] as const;

function normalizeCodexModelName(modelId: string): string {
  const normalized = String(modelId || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase().startsWith(CODEX_MODEL_PREFIX)) {
    return normalized;
  }
  return `${CODEX_MODEL_PREFIX}${normalized}`;
}

function readCodexModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  if (isRecord(payload) && Array.isArray(payload.models)) return payload.models;
  return [];
}

function readCodexModelId(entry: Record<string, unknown>): string {
  if (typeof entry.id === 'string' && entry.id.trim()) return entry.id;
  if (typeof entry.slug === 'string' && entry.slug.trim()) return entry.slug;
  return '';
}

function isCodexModelSupportedInApi(entry: Record<string, unknown>): boolean {
  return entry.supported_in_api !== false;
}

function readCodexContextWindow(entry: Record<string, unknown>): number | null {
  return (
    readPositiveInteger(entry.context_window) ??
    readPositiveInteger(entry.contextWindow) ??
    readPositiveInteger(entry.context_length) ??
    readPositiveInteger(entry.contextLength) ??
    readPositiveInteger(entry.max_context_length) ??
    readPositiveInteger(entry.maxContextLength)
  );
}

function readCodexMaxTokens(entry: Record<string, unknown>): number | null {
  return (
    readPositiveInteger(entry.max_output_tokens) ??
    readPositiveInteger(entry.maxOutputTokens) ??
    readPositiveInteger(entry.max_completion_tokens) ??
    readPositiveInteger(entry.maxCompletionTokens)
  );
}

function appendForwardCompatCodexModels(modelNames: string[]): string[] {
  const ordered = [...modelNames];
  const seen = new Set(modelNames);

  for (const entry of CODEX_FORWARD_COMPAT_MODELS) {
    if (seen.has(entry.model)) continue;
    if (!entry.templateModels.some((template) => seen.has(template))) continue;
    ordered.push(entry.model);
    seen.add(entry.model);
  }

  return ordered;
}

export interface CodexDiscoveryStore {
  discoverModels: (opts?: { force?: boolean }) => Promise<string[]>;
  getModelNames: () => string[];
  getModelContextWindow: (model: string) => number | null;
  getModelMaxTokens: (model: string) => number | null;
}

export function createCodexDiscoveryStore(): CodexDiscoveryStore {
  let discoveredModelNames: string[] = [];
  let contextWindowByModel = new Map<string, number>();
  let maxTokensByModel = new Map<string, number>();
  let discoveredAtMs = 0;
  let discoveryInFlight: Promise<string[]> | null = null;

  function replaceDiscoveryCache(
    modelNames: string[],
    nextContextWindows: Iterable<[string, number]> = [],
    nextMaxTokens: Iterable<[string, number]> = [],
    opts?: { cacheResult?: boolean },
  ): void {
    discoveredModelNames = [...modelNames];
    contextWindowByModel = new Map(nextContextWindows);
    maxTokensByModel = new Map(nextMaxTokens);
    discoveredAtMs = opts?.cacheResult === false ? 0 : Date.now();
  }

  async function fetchCodexModels(): Promise<string[]> {
    const credentials = await resolveCodexCredentials();
    const url = new URL(
      `${normalizeBaseUrl(process.env.HYBRIDCLAW_CODEX_BASE_URL || credentials.baseUrl)}/models`,
    );
    url.searchParams.set('client_version', CODEX_CLIENT_VERSION);
    const response = await fetch(url, {
      headers: credentials.headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const data = readCodexModelEntries(payload);
    const discovered = new Set<string>();
    const contextWindows = new Map<string, number>();
    const maxTokens = new Map<string, number>();
    for (const entry of data) {
      if (!isRecord(entry) || !isCodexModelSupportedInApi(entry)) continue;
      const normalized = normalizeCodexModelName(readCodexModelId(entry));
      if (!normalized) continue;
      discovered.add(normalized);
      const contextWindow = readCodexContextWindow(entry);
      if (contextWindow != null) {
        contextWindows.set(normalized, contextWindow);
      }
      const maxTokensForModel = readCodexMaxTokens(entry);
      if (maxTokensForModel != null) {
        maxTokens.set(normalized, maxTokensForModel);
      }
    }
    const discoveredModelNames = appendForwardCompatCodexModels([
      ...discovered,
    ]);
    // Forward-compat models are catalog-only additions. Metadata maps stay
    // limited to models returned directly by the API; downstream static
    // fallbacks fill known context-window defaults for derived entries.
    replaceDiscoveryCache(discoveredModelNames, contextWindows, maxTokens);
    return discoveredModelNames;
  }

  async function discoverModels(opts?: { force?: boolean }): Promise<string[]> {
    const auth = getCodexAuthStatus();
    if (!auth.authenticated || auth.reloginRequired) {
      replaceDiscoveryCache([], [], [], { cacheResult: false });
      return [];
    }

    const cacheAgeMs = Date.now() - discoveredAtMs;
    if (
      !opts?.force &&
      discoveredAtMs > 0 &&
      cacheAgeMs < CODEX_DISCOVERY_TTL_MS
    ) {
      return [...discoveredModelNames];
    }

    if (discoveryInFlight) return discoveryInFlight;
    const stale = [...discoveredModelNames];

    discoveryInFlight = (async () => {
      try {
        await fetchCodexModels();
        return [...discoveredModelNames];
      } catch {
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
      const normalized = normalizeCodexModelName(model);
      return contextWindowByModel.get(normalized) ?? null;
    },
    getModelMaxTokens: (model: string) => {
      const normalized = normalizeCodexModelName(model);
      return maxTokensByModel.get(normalized) ?? null;
    },
  };
}

const defaultCodexDiscoveryStore = createCodexDiscoveryStore();

export async function discoverCodexModels(opts?: {
  force?: boolean;
}): Promise<string[]> {
  return defaultCodexDiscoveryStore.discoverModels(opts);
}

export function getDiscoveredCodexModelNames(): string[] {
  return defaultCodexDiscoveryStore.getModelNames();
}

export function getDiscoveredCodexModelContextWindow(
  model: string,
): number | null {
  return defaultCodexDiscoveryStore.getModelContextWindow(model);
}

export function getDiscoveredCodexModelMaxTokens(model: string): number | null {
  return defaultCodexDiscoveryStore.getModelMaxTokens(model);
}
