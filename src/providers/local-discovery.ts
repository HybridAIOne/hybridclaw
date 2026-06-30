import {
  LOCAL_BROWSER_API_KEY,
  LOCAL_BROWSER_BASE_URL,
  LOCAL_BROWSER_ENABLED,
  LOCAL_BROWSER_MODEL_BEHAVIOR,
  LOCAL_DEFAULT_CONTEXT_WINDOW,
  LOCAL_DEFAULT_MAX_TOKENS,
  LOCAL_DISCOVERY_CONCURRENCY,
  LOCAL_DISCOVERY_ENABLED,
  LOCAL_DISCOVERY_INTERVAL_MS,
  LOCAL_DISCOVERY_MAX_MODELS,
  LOCAL_ENDPOINTS,
  LOCAL_LLAMACPP_BASE_URL,
  LOCAL_LLAMACPP_ENABLED,
  LOCAL_LLAMACPP_MODEL_BEHAVIOR,
  LOCAL_LMSTUDIO_BASE_URL,
  LOCAL_LMSTUDIO_ENABLED,
  LOCAL_LMSTUDIO_MODEL_BEHAVIOR,
  LOCAL_OLLAMA_BASE_URL,
  LOCAL_OLLAMA_ENABLED,
  LOCAL_OLLAMA_MODEL_BEHAVIOR,
  LOCAL_VLLM_API_KEY,
  LOCAL_VLLM_BASE_URL,
  LOCAL_VLLM_ENABLED,
  LOCAL_VLLM_MODEL_BEHAVIOR,
} from '../config/config.js';
import { resolveModelBehavior } from '../types/model-behavior.js';
import type {
  LocalBackendType,
  LocalEndpointConfig,
  LocalModelBehavior,
  LocalModelInfo,
  LocalThinkingFormat,
} from './local-types.js';
import { LOCAL_BACKEND_IDS } from './provider-ids.js';
import { isRecord, normalizeBaseUrl } from './utils.js';

const DISCOVERY_ORDER: LocalBackendType[] = [...LOCAL_BACKEND_IDS];
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
    LOCAL_VLLM_ENABLED ||
    LOCAL_BROWSER_ENABLED ||
    LOCAL_ENDPOINTS.some((endpoint) => endpoint.enabled)
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
  const modelBehavior = resolveModelBehavior({
    model: normalizedId,
    configured: overrides?.modelBehavior,
  });
  const thinkingFormat =
    overrides?.thinkingFormat || modelBehavior?.thinkingFormat;

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
    ...(overrides?.endpointName
      ? { endpointName: overrides.endpointName }
      : {}),
    ...(thinkingFormat ? { thinkingFormat } : {}),
    ...(modelBehavior ? { modelBehavior } : {}),
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

function applyModelBehavior(
  models: LocalModelInfo[],
  modelBehavior: LocalModelBehavior | undefined,
): LocalModelInfo[] {
  if (!modelBehavior) return models;
  return models.map((model) => {
    const resolved = resolveModelBehavior({
      model: model.id,
      configured: {
        ...(model.modelBehavior || {}),
        ...modelBehavior,
      },
    });
    return {
      ...model,
      ...(resolved ? { modelBehavior: resolved } : {}),
      ...(resolved?.thinkingFormat
        ? { thinkingFormat: resolved.thinkingFormat }
        : {}),
    };
  });
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
    readPositiveInteger(entry.max_model_len) ??
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
  backend: Extract<
    LocalBackendType,
    'browser' | 'llamacpp' | 'lmstudio' | 'vllm'
  >,
  baseUrl: string,
  apiKey?: string,
  endpointName?: string,
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
          endpointName,
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
  endpointName?: string,
  apiKey?: string,
): Promise<LocalModelInfo[]> {
  const apiBase = resolveOpenAICompatBaseUrl(baseUrl);
  const restBase = apiBase.replace(/\/v1$/i, '');
  const headers: Record<string, string> = {};
  if (String(apiKey || '').trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }

  try {
    const payload = await fetchJson(
      `${restBase}/api/v1/models`,
      { headers },
      5_000,
    );
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
            endpointName,
          },
        );
      })
      .filter((model) => Boolean(model.id));
  } catch {
    return fetchOpenAICompatModels('lmstudio', baseUrl, apiKey, endpointName);
  }
}

async function discoverVllmModels(
  baseUrl = LOCAL_VLLM_BASE_URL,
  apiKey = LOCAL_VLLM_API_KEY,
  endpointName?: string,
): Promise<LocalModelInfo[]> {
  return fetchOpenAICompatModels('vllm', baseUrl, apiKey, endpointName);
}

async function discoverLlamacppModels(
  baseUrl = LOCAL_LLAMACPP_BASE_URL,
  endpointName?: string,
  apiKey?: string,
): Promise<LocalModelInfo[]> {
  return fetchOpenAICompatModels('llamacpp', baseUrl, apiKey, endpointName);
}

async function discoverBrowserModels(
  baseUrl = LOCAL_BROWSER_BASE_URL,
  apiKey = LOCAL_BROWSER_API_KEY,
  endpointName?: string,
): Promise<LocalModelInfo[]> {
  return fetchOpenAICompatModels('browser', baseUrl, apiKey, endpointName);
}

async function discoverEndpointModels(
  endpoint: LocalEndpointConfig,
): Promise<LocalModelInfo[]> {
  if (endpoint.type === 'ollama') {
    const models = await discoverOllamaModels(endpoint.baseUrl, {
      maxModels: LOCAL_DISCOVERY_MAX_MODELS,
      concurrency: LOCAL_DISCOVERY_CONCURRENCY,
    });
    return applyModelBehavior(
      models.map((model) => ({ ...model, endpointName: endpoint.name })),
      endpoint.modelBehavior,
    );
  }
  if (endpoint.type === 'lmstudio') {
    return applyModelBehavior(
      await discoverLmStudioModels(
        endpoint.baseUrl,
        endpoint.name,
        endpoint.apiKey,
      ),
      endpoint.modelBehavior,
    );
  }
  if (endpoint.type === 'llamacpp') {
    return applyModelBehavior(
      await discoverLlamacppModels(
        endpoint.baseUrl,
        endpoint.name,
        endpoint.apiKey,
      ),
      endpoint.modelBehavior,
    );
  }
  if (endpoint.type === 'browser') {
    return applyModelBehavior(
      await discoverBrowserModels(
        endpoint.baseUrl,
        endpoint.apiKey,
        endpoint.name,
      ),
      endpoint.modelBehavior,
    );
  }
  return applyModelBehavior(
    await discoverVllmModels(endpoint.baseUrl, endpoint.apiKey, endpoint.name),
    endpoint.modelBehavior,
  );
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
  const discoveredByEndpoint = new Map<string, Map<string, LocalModelInfo>>();
  const discoveredById = new Map<string, LocalModelInfo>();

  function replaceDiscoveryCache(models: LocalModelInfo[]): void {
    discoveredByBackend.clear();
    discoveredByEndpoint.clear();
    discoveredById.clear();

    for (const backend of DISCOVERY_ORDER) {
      discoveredByBackend.set(backend, new Map());
    }

    for (const model of models) {
      if (model.endpointName) {
        const endpointMap =
          discoveredByEndpoint.get(model.endpointName) ?? new Map();
        endpointMap.set(model.id, model);
        discoveredByEndpoint.set(model.endpointName, endpointMap);
      } else {
        const backendMap = discoveredByBackend.get(model.backend);
        if (!backendMap) continue;
        backendMap.set(model.id, model);
      }
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
    for (const endpoint of LOCAL_ENDPOINTS) {
      const endpointMap = discoveredByEndpoint.get(endpoint.name);
      if (!endpointMap) continue;
      models.push(...endpointMap.values());
    }
    return models;
  }

  function getDiscoveredModelNames(): string[] {
    const names = new Set<string>();
    for (const model of getDiscoveredModels()) {
      names.add(`${model.endpointName || model.backend}/${model.id}`);
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
      const endpointMap = discoveredByEndpoint.get(backend);
      if (endpointMap) {
        return endpointMap.get(modelId) || null;
      }
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
            })
              .then((models) =>
                applyModelBehavior(models, LOCAL_OLLAMA_MODEL_BEHAVIOR),
              )
              .catch(() => []),
          );
        }
        if (LOCAL_LMSTUDIO_ENABLED) {
          tasks.push(
            discoverLmStudioModels(LOCAL_LMSTUDIO_BASE_URL)
              .then((models) =>
                applyModelBehavior(models, LOCAL_LMSTUDIO_MODEL_BEHAVIOR),
              )
              .catch(() => []),
          );
        }
        if (LOCAL_LLAMACPP_ENABLED) {
          tasks.push(
            discoverLlamacppModels(LOCAL_LLAMACPP_BASE_URL)
              .then((models) =>
                applyModelBehavior(models, LOCAL_LLAMACPP_MODEL_BEHAVIOR),
              )
              .catch(() => []),
          );
        }
        if (LOCAL_VLLM_ENABLED) {
          tasks.push(
            discoverVllmModels(LOCAL_VLLM_BASE_URL, LOCAL_VLLM_API_KEY)
              .then((models) =>
                applyModelBehavior(models, LOCAL_VLLM_MODEL_BEHAVIOR),
              )
              .catch(() => []),
          );
        }
        if (LOCAL_BROWSER_ENABLED) {
          tasks.push(
            discoverBrowserModels(LOCAL_BROWSER_BASE_URL, LOCAL_BROWSER_API_KEY)
              .then((models) =>
                applyModelBehavior(models, LOCAL_BROWSER_MODEL_BEHAVIOR),
              )
              .catch(() => []),
          );
        }
        for (const endpoint of LOCAL_ENDPOINTS) {
          if (!endpoint.enabled) continue;
          tasks.push(discoverEndpointModels(endpoint).catch(() => []));
        }

        const discovered = (await Promise.all(tasks)).flat();
        const deduped: LocalModelInfo[] = [];
        const seen = new Set<string>();
        const orderedPrefixes = [
          ...DISCOVERY_ORDER,
          ...LOCAL_ENDPOINTS.map((endpoint) => endpoint.name),
        ];
        for (const prefix of orderedPrefixes) {
          for (const model of discovered.filter((entry) =>
            entry.endpointName
              ? entry.endpointName === prefix
              : entry.backend === prefix,
          )) {
            const cacheKey = `${model.endpointName || model.backend}:${model.id}`;
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
  return getLocalModelInfo(model)?.thinkingFormat || null;
}

export function resolveLocalModelBehavior(
  model: string,
): LocalModelBehavior | null {
  return getLocalModelInfo(model)?.modelBehavior || null;
}

export function startDiscoveryLoop(): void {
  defaultLocalDiscoveryStore.startLoop();
}

export function stopDiscoveryLoop(): void {
  defaultLocalDiscoveryStore.stopLoop();
}
