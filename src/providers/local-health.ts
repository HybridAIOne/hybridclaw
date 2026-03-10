import {
  LOCAL_ENABLED,
  LOCAL_HEALTH_CHECK_ENABLED,
  LOCAL_HEALTH_CHECK_INTERVAL_MS,
  LOCAL_HEALTH_CHECK_TIMEOUT_MS,
  LOCAL_LMSTUDIO_BASE_URL,
  LOCAL_LMSTUDIO_ENABLED,
  LOCAL_OLLAMA_BASE_URL,
  LOCAL_OLLAMA_ENABLED,
  LOCAL_VLLM_API_KEY,
  LOCAL_VLLM_BASE_URL,
  LOCAL_VLLM_ENABLED,
} from '../config/config.js';
import { resolveOllamaApiBase } from './local-discovery.js';
import type {
  HealthCheckResult,
  LocalBackendType,
  ModelHealthCheckResult,
} from './local-types.js';

let healthTimer: ReturnType<typeof setInterval> | null = null;
const backendHealth = new Map<LocalBackendType, HealthCheckResult>();

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildOpenAICompatHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (String(apiKey || '').trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }
  return headers;
}

async function fetchHealthJson(
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

export async function checkConnection(
  backend: LocalBackendType,
  baseUrl: string,
  timeoutMs = LOCAL_HEALTH_CHECK_TIMEOUT_MS,
  apiKey?: string,
): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  const endpoint =
    backend === 'ollama'
      ? `${resolveOllamaApiBase(baseUrl)}/api/tags`
      : `${normalizeBaseUrl(baseUrl)}/models`;

  try {
    const payload = await fetchHealthJson(
      endpoint,
      {
        headers:
          backend === 'vllm' ? buildOpenAICompatHeaders(apiKey) : undefined,
      },
      timeoutMs,
    );
    const modelCount =
      backend === 'ollama'
        ? isRecord(payload) && Array.isArray(payload.models)
          ? payload.models.length
          : undefined
        : isRecord(payload) && Array.isArray(payload.data)
          ? payload.data.length
          : undefined;
    return {
      backend,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      ...(typeof modelCount === 'number' ? { modelCount } : {}),
    };
  } catch (error) {
    return {
      backend,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkModelConnection(
  backend: LocalBackendType,
  baseUrl: string,
  modelId: string,
  timeoutMs = LOCAL_HEALTH_CHECK_TIMEOUT_MS,
  apiKey?: string,
): Promise<ModelHealthCheckResult> {
  const startedAt = Date.now();
  try {
    if (backend === 'ollama') {
      await fetchHealthJson(
        `${resolveOllamaApiBase(baseUrl)}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'ping' }],
            stream: false,
            options: { num_predict: 1 },
          }),
        },
        timeoutMs,
      );
    } else {
      await fetchHealthJson(
        `${normalizeBaseUrl(baseUrl)}/chat/completions`,
        {
          method: 'POST',
          headers: buildOpenAICompatHeaders(apiKey),
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          }),
        },
        timeoutMs,
      );
    }

    return {
      modelId,
      backend,
      usable: true,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      modelId,
      backend,
      usable: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkAllBackends(): Promise<
  Map<LocalBackendType, HealthCheckResult>
> {
  const next = new Map<LocalBackendType, HealthCheckResult>();
  if (!LOCAL_ENABLED || !LOCAL_HEALTH_CHECK_ENABLED) {
    backendHealth.clear();
    return next;
  }

  const tasks: Array<Promise<HealthCheckResult>> = [];
  if (LOCAL_OLLAMA_ENABLED) {
    tasks.push(checkConnection('ollama', LOCAL_OLLAMA_BASE_URL));
  }
  if (LOCAL_LMSTUDIO_ENABLED) {
    tasks.push(checkConnection('lmstudio', LOCAL_LMSTUDIO_BASE_URL));
  }
  if (LOCAL_VLLM_ENABLED) {
    tasks.push(
      checkConnection(
        'vllm',
        LOCAL_VLLM_BASE_URL,
        LOCAL_HEALTH_CHECK_TIMEOUT_MS,
        LOCAL_VLLM_API_KEY,
      ),
    );
  }

  for (const result of await Promise.all(tasks)) {
    next.set(result.backend, result);
  }

  backendHealth.clear();
  for (const [backend, result] of next) {
    backendHealth.set(backend, result);
  }
  return new Map(backendHealth);
}

export function getBackendHealth(
  backend: LocalBackendType,
): HealthCheckResult | null {
  return backendHealth.get(backend) || null;
}

export function getAllBackendHealth(): Map<
  LocalBackendType,
  HealthCheckResult
> {
  return new Map(backendHealth);
}

export function startHealthCheckLoop(): void {
  stopHealthCheckLoop();
  if (!LOCAL_ENABLED || !LOCAL_HEALTH_CHECK_ENABLED) {
    backendHealth.clear();
    return;
  }
  void checkAllBackends();
  healthTimer = setInterval(
    () => {
      void checkAllBackends();
    },
    Math.max(5_000, LOCAL_HEALTH_CHECK_INTERVAL_MS),
  );
}

export function stopHealthCheckLoop(): void {
  if (!healthTimer) return;
  clearInterval(healthTimer);
  healthTimer = null;
}

export function resetLocalHealthState(): void {
  stopHealthCheckLoop();
  backendHealth.clear();
}
