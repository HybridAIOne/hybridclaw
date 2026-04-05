import { resolveAnthropicAuth } from '../auth/anthropic-auth.js';
import { resolveCodexCredentials } from '../auth/codex-auth.js';
import { getHybridAIAuthStatus } from '../auth/hybridai-auth.js';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_ENABLED,
  CODEX_BASE_URL,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_ENABLED,
  MISTRAL_BASE_URL,
  MISTRAL_ENABLED,
  OPENROUTER_BASE_URL,
  OPENROUTER_ENABLED,
} from '../config/config.js';
import { normalizeAnthropicBaseUrl } from '../providers/anthropic-utils.js';
import { CODEX_CLIENT_VERSION } from '../providers/codex-constants.js';
import { fetchHybridAIBots } from '../providers/hybridai-bots.js';
import { readApiKeyForOpenAICompatProvider } from '../providers/openai-compat-remote.js';
import { buildOpenRouterAttributionHeaders } from '../providers/openrouter-utils.js';
import { isRecord, normalizeBaseUrl } from '../providers/utils.js';

export interface ProviderProbeResult {
  reachable: boolean;
  detail: string;
  modelCount?: number;
}

export async function probeHybridAI(): Promise<ProviderProbeResult> {
  const auth = getHybridAIAuthStatus();
  if (!auth.authenticated) {
    return {
      reachable: false,
      detail: 'API key missing',
    };
  }

  const startedAt = Date.now();
  const bots = await fetchHybridAIBots({ cacheTtlMs: 0 });
  const latencyMs = Date.now() - startedAt;
  return {
    reachable: true,
    detail: `${latencyMs}ms`,
    modelCount: bots.length,
  };
}

export async function probeOpenRouter(): Promise<ProviderProbeResult> {
  if (!OPENROUTER_ENABLED) {
    return {
      reachable: false,
      detail: 'Provider disabled',
    };
  }

  const apiKey = readApiKeyForOpenAICompatProvider('openrouter', {
    required: false,
  });
  if (!apiKey) {
    return {
      reachable: false,
      detail: 'API key missing',
    };
  }

  const startedAt = Date.now();
  const response = await fetch(
    `${normalizeBaseUrl(OPENROUTER_BASE_URL)}/models`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...buildOpenRouterAttributionHeaders(),
      },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { data?: unknown[] };
  return {
    reachable: true,
    detail: `${Date.now() - startedAt}ms`,
    modelCount: Array.isArray(payload.data) ? payload.data.length : 0,
  };
}

export async function probeAnthropic(): Promise<ProviderProbeResult> {
  if (!ANTHROPIC_ENABLED) {
    return {
      reachable: false,
      detail: 'Provider disabled',
    };
  }

  let auth: ReturnType<typeof resolveAnthropicAuth>;
  try {
    auth = resolveAnthropicAuth();
  } catch (error) {
    return {
      reachable: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const headers: Record<string, string> = {
    ...auth.headers,
  };
  if (auth.method === 'cli') {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  } else {
    headers['x-api-key'] = auth.apiKey;
  }

  const startedAt = Date.now();
  const response = await fetch(
    `${normalizeAnthropicBaseUrl(ANTHROPIC_BASE_URL)}/models`,
    {
      headers,
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { data?: unknown[] };
  return {
    reachable: true,
    detail: `${Date.now() - startedAt}ms`,
    modelCount: Array.isArray(payload.data) ? payload.data.length : 0,
  };
}

export async function probeHuggingFace(): Promise<ProviderProbeResult> {
  if (!HUGGINGFACE_ENABLED) {
    return {
      reachable: false,
      detail: 'Provider disabled',
    };
  }

  const apiKey = readApiKeyForOpenAICompatProvider('huggingface', {
    required: false,
  });
  if (!apiKey) {
    return {
      reachable: false,
      detail: 'API key missing',
    };
  }

  const startedAt = Date.now();
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

  const payload = (await response.json()) as { data?: unknown[] };
  return {
    reachable: true,
    detail: `${Date.now() - startedAt}ms`,
    modelCount: Array.isArray(payload.data) ? payload.data.length : 0,
  };
}

export async function probeMistral(): Promise<ProviderProbeResult> {
  if (!MISTRAL_ENABLED) {
    return {
      reachable: false,
      detail: 'Provider disabled',
    };
  }

  const apiKey = readApiKeyForOpenAICompatProvider('mistral', {
    required: false,
  });
  if (!apiKey) {
    return {
      reachable: false,
      detail: 'API key missing',
    };
  }

  const startedAt = Date.now();
  const response = await fetch(`${normalizeBaseUrl(MISTRAL_BASE_URL)}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { data?: unknown[] };
  return {
    reachable: true,
    detail: `${Date.now() - startedAt}ms`,
    modelCount: Array.isArray(payload.data) ? payload.data.length : 0,
  };
}

export async function probeCodex(): Promise<ProviderProbeResult> {
  const credentials = await resolveCodexCredentials();
  const baseUrl = (
    process.env.HYBRIDCLAW_CODEX_BASE_URL ||
    CODEX_BASE_URL ||
    credentials.baseUrl
  )
    .trim()
    .replace(/\/+$/g, '');
  const startedAt = Date.now();
  const url = new URL(`${baseUrl}/models`);
  url.searchParams.set('client_version', CODEX_CLIENT_VERSION);
  const response = await fetch(url, {
    headers: credentials.headers,
    signal: AbortSignal.timeout(5_000),
  });

  if (response.ok || response.status === 404) {
    const payload = response.ok ? ((await response.json()) as unknown) : null;
    const data = isRecord(payload)
      ? Array.isArray(payload.data)
        ? payload.data
        : []
      : Array.isArray(payload)
        ? payload
        : [];
    return {
      reachable: response.status !== 404,
      detail:
        response.status === 404
          ? 'models endpoint not found'
          : `${Date.now() - startedAt}ms`,
      modelCount: response.ok ? data.length : 0,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      reachable: false,
      detail: 'Login required',
    };
  }

  throw new Error(`HTTP ${response.status}`);
}
