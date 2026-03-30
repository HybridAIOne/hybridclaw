import { resolveCodexCredentials } from '../auth/codex-auth.js';
import { getHybridAIAuthStatus } from '../auth/hybridai-auth.js';
import {
  CODEX_BASE_URL,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_ENABLED,
  MISTRAL_BASE_URL,
  MISTRAL_ENABLED,
  OPENROUTER_BASE_URL,
  OPENROUTER_ENABLED,
} from '../config/config.js';
import { readHuggingFaceApiKey } from '../providers/huggingface-utils.js';
import { fetchHybridAIBots } from '../providers/hybridai-bots.js';
import { readMistralApiKey } from '../providers/mistral-utils.js';
import {
  buildOpenRouterAttributionHeaders,
  readOpenRouterApiKey,
} from '../providers/openrouter-utils.js';
import { normalizeBaseUrl } from '../providers/utils.js';

export interface ProviderProbeResult {
  reachable: boolean;
  detail: string;
  modelCount?: number;
}

function normalizeCodexProbeModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed.toLowerCase().startsWith('openai-codex/')) return trimmed;
  return trimmed.slice('openai-codex/'.length) || trimmed;
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

  const apiKey = readOpenRouterApiKey({ required: false });
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

export async function probeHuggingFace(): Promise<ProviderProbeResult> {
  if (!HUGGINGFACE_ENABLED) {
    return {
      reachable: false,
      detail: 'Provider disabled',
    };
  }

  const apiKey = readHuggingFaceApiKey({ required: false });
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

  const apiKey = readMistralApiKey({ required: false });
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

export async function probeCodex(model: string): Promise<ProviderProbeResult> {
  const credentials = await resolveCodexCredentials();
  const baseUrl = (
    process.env.HYBRIDCLAW_CODEX_BASE_URL ||
    CODEX_BASE_URL ||
    credentials.baseUrl
  )
    .trim()
    .replace(/\/+$/g, '');
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: credentials.headers,
    body: JSON.stringify({
      model: normalizeCodexProbeModel(model),
      input: [],
      tools: 'invalid',
    }),
    signal: AbortSignal.timeout(5_000),
  });

  if (
    response.ok ||
    response.status === 400 ||
    response.status === 404 ||
    response.status === 422
  ) {
    return {
      reachable: response.status !== 404,
      detail:
        response.status === 404
          ? 'responses endpoint not found'
          : `${Date.now() - startedAt}ms`,
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
