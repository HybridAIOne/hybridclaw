import {
  LOCAL_DEFAULT_CONTEXT_WINDOW,
  LOCAL_DEFAULT_MAX_TOKENS,
  LOCAL_DISCOVERY_CONCURRENCY,
  LOCAL_DISCOVERY_ENABLED,
  LOCAL_DISCOVERY_INTERVAL_MS,
  LOCAL_DISCOVERY_MAX_MODELS,
  LOCAL_LLAMACPP_BASE_URL,
  LOCAL_LLAMACPP_ENABLED,
  LOCAL_LMSTUDIO_BASE_URL,
  LOCAL_LMSTUDIO_ENABLED,
  LOCAL_OLLAMA_BASE_URL,
  LOCAL_OLLAMA_ENABLED,
  LOCAL_VLLM_API_KEY,
  LOCAL_VLLM_BASE_URL,
  LOCAL_VLLM_ENABLED,
} from '../config/config.js';
import type {
  LocalBackendType,
  LocalModelInfo,
  LocalThinkingFormat,
} from './local-types.js';
import { isRecord, normalizeBaseUrl } from './utils.js';

const DISCOVERY_ORDER: LocalBackendType[] = [
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
];
const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

function hasEnabledLocalBackend(): boolean {
  return (
    LOCAL_OLLAMA_ENABLED ||
    LOCAL_LMSTUDIO_ENABLED ||
    LOCAL_LLAMACPP_ENABLED ||
    LOCAL_VLLM_ENABLED
  );
}

function normalizeModelId(modelId: string): string {
  return String(modelId || '').trim();
}

function isReasoningModel(modelId: string): boolean {
  return (
    /\b(r1|reasoning|think)\b/i.test(modelId) ||
    /(^|[-_.])r1($|[-_.])/i.test(modelId)
  );
}

function detectThinkingFormat(
  modelId: string,
): LocalThinkingFormat | undefined {
  const normalized = normalizeModelId(modelId).toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('qwen') || normalized.includes('qwq')) {
    return 'qwen';
  }
  return undefined;
}

function createLocalModelInfo(
  backend: LocalBackendType,
  modelId: string,
  overrides?: Partial<LocalModelInfo>,
): LocalModelInfo {
  const normalizedId = normalizeModelId(modelId);
  const contextWindow =
    typeof overrides?.contextWindow === 'number' && overrides.contextWindow > 0
      ? Math.floor(overrides.contextWindow)
      : LOCAL_DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    typeof overrides?.maxTokens === 'number' && overrides.maxTokens > 0
      ? Math.floor(overrides.maxTokens)
      : LOCAL_DEFAULT_MAX_TOKENS;

  return {
    id: normalizedId,
    name: overrides?.name || normalizedId,
    contextWindow,
    maxTokens,
    isReasoning:
      typeof overrides?.isReasoning === 'boolean'
        ? overrides.isReasoning
        : isReasoningModel(normalizedId),
    backend,
    ...(overrides?.thinkingFormat || detectThinkingFormat(normalizedId)
      ? {
          thinkingFormat:
            overrides?.thinkingFormat || detectThinkingFormat(normalizedId),
        }
      : {}),
    cost: ZERO_COST,
    ...(typeof overrides?.sizeBytes === 'number'
      ? { sizeBytes: overrides.sizeBytes }
      : {}),
    ...(overrides?.family ? { family: overrides.family } : {}),
    ...(overrides?.parameterSize
      ? { parameterSize: overrides.parameterSize }
      : {}),
  };
}

async function fetchJson(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as unknown;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function readContextWindowFromShowResponse(
  payload: unknown,
): number | undefined {
  const modelInfo =
    isRecord(payload) && isRecord(payload.model_info)
      ? payload.model_info
      : null;
  if (!modelInfo) return undefined;

  const candidates: number[] = [];
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!/context_length|ctx_length/i.test(key)) continue;
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseInt(value, 10)
          : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      candidates.push(Math.floor(parsed));
    }
  }
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

function readContextWindowFromModelEntry(
  entry: Record<string, unknown>,
): number | undefined {
  const loadedInstances = Array.isArray(entry.loaded_instances)
    ? entry.loaded_instances
    : [];

  for (const instance of loadedInstances) {
    if (!isRecord(instance) || !isRecord(instance.config)) continue;
    const loadedContextLength = readPositiveInteger(
      instance.config.context_length,
    );
    if (loadedContextLength) return loadedContextLength;
  }

  return (
    readPositiveInteger(entry.loaded_context_length) ??
    readPositiveInteger(entry.context_length) ??
    readPositiveInteger(entry.max_context_length) ??
    readPositiveInteger(entry.maxContextLength)
  );
}

async function runWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const outputs: TOutput[] = [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        outputs[index] = await worker(items[index]);
      }
    }),
  );
  return outputs;
}

export function resolveOllamaApiBase(configuredBaseUrl?: string): string {
  const normalized = normalizeBaseUrl(
    configuredBaseUrl || LOCAL_OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  );
  return normalized.replace(/\/v1$/i, '') || 'http://127.0.0.1:11434';
}

function resolveOpenAICompatBaseUrl(configuredBaseUrl: string): string {
  return normalizeBaseUrl(configuredBaseUrl);
}

async function fetchOpenAICompatModels(
  backend: Extract<LocalBackendType, 'llamacpp' | 'lmstudio' | 'vllm'>,
  baseUrl: string,
  apiKey?: string,
): Promise<LocalModelInfo[]> {
  const headers: Record<string, string> = {};
  if (String(apiKey || '').trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }

  const apiBase = resolveOpenAICompatBaseUrl(baseUrl);
  const payload = await fetchJson(`${apiBase}/models`, { headers }, 5_000);
  const data =
    isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];

  return data
    .filter((entry) => isRecord(entry) && typeof entry.id === 'string')
    .slice(0, LOCAL_DISCOVERY_MAX_MODELS)
    .map((entry) =>
      createLocalModelInfo(
        backend,
        String((entry as Record<string, unknown>).id || '').trim(),
        {
          contextWindow: readContextWindowFromModelEntry(
            entry as Record<string, unknown>,
          ),
        },
      ),
    )
    .filter((model) => Boolean(model.id));
}

async function discoverOllamaModels(
  baseUrl = LOCAL_OLLAMA_BASE_URL,
  opts?: { maxModels?: number; concurrency?: number },
): Promise<LocalModelInfo[]> {
  const apiBase = resolveOllamaApiBase(baseUrl);
  const payload = await fetchJson(`${apiBase}/api/tags`, {}, 5_000);
  const records =
    isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  const maxModels = Math.max(
    1,
    Math.min(opts?.maxModels ?? LOCAL_DISCOVERY_MAX_MODELS, records.length),
  );
  const concurrency = Math.max(
    1,
    opts?.concurrency ?? LOCAL_DISCOVERY_CONCURRENCY,
  );
  const tags = records
    .filter((entry) => isRecord(entry) && typeof entry.name === 'string')
    .slice(0, maxModels);

  const models = await runWithConcurrency(tags, concurrency, async (entry) => {
    const record = entry as Record<string, unknown>;
    const modelId = String(record.name || '').trim();
    const details = isRecord(record.details) ? record.details : null;
    let contextWindow = LOCAL_DEFAULT_CONTEXT_WINDOW;

    try {
      const showResponse = await fetchJson(
        `${apiBase}/api/show`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId }),
        },
        3_000,
      );
      contextWindow =
        readContextWindowFromShowResponse(showResponse) ||
        LOCAL_DEFAULT_CONTEXT_WINDOW;
    } catch {
      // Best-effort enrichment only.
    }

    return createLocalModelInfo('ollama', modelId, {
      contextWindow,
      sizeBytes:
        typeof record.size === 'number' && Number.isFinite(record.size)
          ? Math.floor(record.size)
          : undefined,
      family:
        details && typeof details.family === 'string'
          ? details.family
          : undefined,
      parameterSize:
        details && typeof details.parameter_size === 'string'
          ? details.parameter_size
          : undefined,
    });
  });

  return models.filter((model) => Boolean(model.id));
}

async function discoverLmStudioModels(
  baseUrl = LOCAL_LMSTUDIO_BASE_URL,
): Promise<LocalModelInfo[]> {
  const apiBase = resolveOpenAICompatBaseUrl(baseUrl);
  const restBase = apiBase.replace(/\/v1$/i, '');

  try {
    const payload = await fetchJson(`${restBase}/api/v1/models`, {}, 5_000);
    const models =
      isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];

    return models
      .filter(
        (entry) =>
          isRecord(entry) &&
          (typeof entry.key === 'string' || typeof entry.id === 'string'),
      )
      .slice(0, LOCAL_DISCOVERY_MAX_MODELS)
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        return createLocalModelInfo(
          'lmstudio',
          String(record.key || record.id || '').trim(),
          {
            contextWindow:
              readContextWindowFromModelEntry(record) ||
              LOCAL_DEFAULT_CONTEXT_WINDOW,
            name:
              typeof record.display_name === 'string'
                ? String(record.display_name).trim()
                : undefined,
            sizeBytes: readPositiveInteger(record.size_bytes),
            family:
              typeof record.architecture === 'string'
                ? String(record.architecture).trim()
                : undefined,
            parameterSize:
              typeof record.params_string === 'string'
                ? String(record.params_string).trim()
                : undefined,
          },
        );
      })
      .filter((model) => Boolean(model.id));
  } catch {
    return fetchOpenAICompatModels('lmstudio', baseUrl);
  }
}

async function discoverVllmModels(
  baseUrl = LOCAL_VLLM_BASE_URL,
  apiKey = LOCAL_VLLM_API_KEY,
): Promise<LocalModelInfo[]> {
  return fetchOpenAICompatModels('vllm', baseUrl, apiKey);
}

async function discoverLlamacppModels(
  baseUrl = LOCAL_LLAMACPP_BASE_URL,
): Promise<LocalModelInfo[]> {
  return fetchOpenAICompatModels('llamacpp', baseUrl);
}

export interface LocalDiscoveryStore {
  discoverAllModels: (opts?: { force?: boolean }) => Promise<LocalModelInfo[]>;
  getDiscoveredModels: () => LocalModelInfo[];
  getDiscoveredModelNames: () => string[];
  getModelInfo: (model: string) => LocalModelInfo | null;
  startLoop: () => void;
  stopLoop: () => void;
}

export function createLocalDiscoveryStore(): LocalDiscoveryStore {
  let discoveryTimer: ReturnType<typeof setInterval> | null = null;
  let discoveryInFlight: Promise<LocalModelInfo[]> | null = null;
  let lastDiscoveryAtMs = 0;
  const discoveredByBackend = new Map<
    LocalBackendType,
    Map<string, LocalModelInfo>
  >();
  const discoveredById = new Map<string, LocalModelInfo>();

  function replaceDiscoveryCache(models: LocalModelInfo[]): void {
    discoveredByBackend.clear();
    discoveredById.clear();

    for (const backend of DISCOVERY_ORDER) {
      discoveredByBackend.set(backend, new Map());
    }

    for (const model of models) {
      const backendMap = discoveredByBackend.get(model.backend);
      if (!backendMap) continue;
      backendMap.set(model.id, model);
      if (!discoveredById.has(model.id)) {
        discoveredById.set(model.id, model);
      }
    }
  }

  function getDiscoveredModels(): LocalModelInfo[] {
    const models: LocalModelInfo[] = [];
    for (const backend of DISCOVERY_ORDER) {
      const backendMap = discoveredByBackend.get(backend);
      if (!backendMap) continue;
      models.push(...backendMap.values());
    }
    return models;
  }

  function getDiscoveredModelNames(): string[] {
    const names = new Set<string>();
    for (const model of getDiscoveredModels()) {
      names.add(`${model.backend}/${model.id}`);
    }
    return [...names];
  }

  function getModelInfo(model: string): LocalModelInfo | null {
    const normalized = normalizeModelId(model);
    if (!normalized) return null;

    const slashIndex = normalized.indexOf('/');
    if (slashIndex > 0) {
      const backend = normalized.slice(0, slashIndex) as LocalBackendType;
      const modelId = normalized.slice(slashIndex + 1);
      const backendMap = discoveredByBackend.get(backend);
      return backendMap?.get(modelId) || null;
    }

    return discoveredById.get(normalized) || null;
  }

  async function discoverAllModels(opts?: {
    force?: boolean;
  }): Promise<LocalModelInfo[]> {
    if (!hasEnabledLocalBackend() || !LOCAL_DISCOVERY_ENABLED) {
      lastDiscoveryAtMs = 0;
      replaceDiscoveryCache([]);
      return [];
    }

    const cacheTtlMs = Math.max(10_000, LOCAL_DISCOVERY_INTERVAL_MS);
    if (
      !opts?.force &&
      lastDiscoveryAtMs > 0 &&
      Date.now() - lastDiscoveryAtMs < cacheTtlMs
    ) {
      return getDiscoveredModels();
    }

    if (discoveryInFlight) return discoveryInFlight;

    discoveryInFlight = (async () => {
      try {
        const tasks: Array<Promise<LocalModelInfo[]>> = [];
        if (LOCAL_OLLAMA_ENABLED) {
          tasks.push(
            discoverOllamaModels(LOCAL_OLLAMA_BASE_URL, {
              maxModels: LOCAL_DISCOVERY_MAX_MODELS,
              concurrency: LOCAL_DISCOVERY_CONCURRENCY,
            }).catch(() => []),
          );
        }
        if (LOCAL_LMSTUDIO_ENABLED) {
          tasks.push(
            discoverLmStudioModels(LOCAL_LMSTUDIO_BASE_URL).catch(() => []),
          );
        }
        if (LOCAL_LLAMACPP_ENABLED) {
          tasks.push(
            discoverLlamacppModels(LOCAL_LLAMACPP_BASE_URL).catch(() => []),
          );
        }
        if (LOCAL_VLLM_ENABLED) {
          tasks.push(
            discoverVllmModels(LOCAL_VLLM_BASE_URL, LOCAL_VLLM_API_KEY).catch(
              () => [],
            ),
          );
        }

        const discovered = (await Promise.all(tasks)).flat();
        const deduped: LocalModelInfo[] = [];
        const seen = new Set<string>();
        for (const backend of DISCOVERY_ORDER) {
          for (const model of discovered.filter(
            (entry) => entry.backend === backend,
          )) {
            const cacheKey = `${model.backend}:${model.id}`;
            if (seen.has(cacheKey)) continue;
            seen.add(cacheKey);
            deduped.push(model);
          }
        }

        replaceDiscoveryCache(deduped);
        lastDiscoveryAtMs = Date.now();
        return deduped;
      } finally {
        discoveryInFlight = null;
      }
    })();

    return discoveryInFlight;
  }

  function stopLoop(): void {
    if (!discoveryTimer) return;
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }

  function startLoop(): void {
    stopLoop();
    if (!hasEnabledLocalBackend() || !LOCAL_DISCOVERY_ENABLED) {
      lastDiscoveryAtMs = 0;
      replaceDiscoveryCache([]);
      return;
    }
    void discoverAllModels({ force: true });
    discoveryTimer = setInterval(
      () => {
        void discoverAllModels({ force: true });
      },
      Math.max(10_000, LOCAL_DISCOVERY_INTERVAL_MS),
    );
  }

  return {
    discoverAllModels,
    getDiscoveredModels,
    getDiscoveredModelNames,
    getModelInfo,
    startLoop,
    stopLoop,
  };
}

const defaultLocalDiscoveryStore = createLocalDiscoveryStore();

export async function discoverAllLocalModels(opts?: {
  force?: boolean;
}): Promise<LocalModelInfo[]> {
  return defaultLocalDiscoveryStore.discoverAllModels(opts);
}

export function getDiscoveredLocalModels(): LocalModelInfo[] {
  return defaultLocalDiscoveryStore.getDiscoveredModels();
}

export function getDiscoveredLocalModelNames(): string[] {
  return defaultLocalDiscoveryStore.getDiscoveredModelNames();
}

export function getLocalModelInfo(model: string): LocalModelInfo | null {
  return defaultLocalDiscoveryStore.getModelInfo(model);
}

export function resolveLocalModelContextWindow(model: string): number | null {
  return getLocalModelInfo(model)?.contextWindow ?? null;
}

export function resolveLocalModelThinkingFormat(
  model: string,
): LocalThinkingFormat | null {
  return (
    getLocalModelInfo(model)?.thinkingFormat ||
    detectThinkingFormat(model) ||
    null
  );
}

export function startDiscoveryLoop(): void {
  defaultLocalDiscoveryStore.startLoop();
}

export function stopDiscoveryLoop(): void {
  defaultLocalDiscoveryStore.stopLoop();
}
