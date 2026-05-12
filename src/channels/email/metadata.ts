import type { TokenUsageStats } from '../../types/usage.js';
import { normalizeNullableTrimmedString as trimString } from '../../utils/normalized-strings.js';

export type EmailDeliveryTokenSource = 'api' | 'estimated';

export interface EmailDeliveryMetadata {
  agentId: string | null;
  model: string | null;
  provider: string | null;
  totalTokens: number | null;
  tokenSource: EmailDeliveryTokenSource | null;
}

interface HeaderLookup {
  get(name: string): unknown;
}

const EMAIL_METADATA_HEADERS = {
  agentId: 'X-HybridClaw-Agent-Id',
  model: 'X-HybridClaw-LLM',
  provider: 'X-HybridClaw-Provider',
  totalTokens: 'X-HybridClaw-Total-Tokens',
  tokenSource: 'X-HybridClaw-Token-Source',
} as const;

function normalizeTokenCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.round(value) : null;
  }
  const trimmed = trimString(value);
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function normalizeTokenSource(value: unknown): EmailDeliveryTokenSource | null {
  const normalized = trimString(value)?.toLowerCase();
  return normalized === 'api' || normalized === 'estimated' ? normalized : null;
}

function resolveHeaderLookup(
  headers: HeaderLookup | Map<string, unknown> | null | undefined,
): HeaderLookup | null {
  if (!headers || typeof headers.get !== 'function') {
    return null;
  }
  return headers;
}

function readHeaderValue(lookup: HeaderLookup, headerName: string): unknown {
  const direct = lookup.get(headerName);
  if (direct != null) return direct;

  const lowerCased = headerName.toLowerCase();
  const lower = lookup.get(lowerCased);
  if (lower != null) return lower;

  if (lookup instanceof Map) {
    for (const [key, value] of lookup.entries()) {
      if (key.toLowerCase() === lowerCased) {
        return value;
      }
    }
  }

  return undefined;
}

export function buildEmailDeliveryMetadata(params: {
  agentId?: string | null;
  model?: string | null;
  provider?: string | null;
  tokenUsage?: TokenUsageStats;
}): EmailDeliveryMetadata | null {
  const agentId = trimString(params.agentId);
  const model = trimString(params.model);
  const provider = trimString(params.provider);

  let totalTokens: number | null = null;
  let tokenSource: EmailDeliveryTokenSource | null = null;
  if (params.tokenUsage) {
    if (
      params.tokenUsage.apiUsageAvailable &&
      params.tokenUsage.apiTotalTokens > 0
    ) {
      totalTokens = Math.round(params.tokenUsage.apiTotalTokens);
      tokenSource = 'api';
    } else if (params.tokenUsage.estimatedTotalTokens > 0) {
      totalTokens = Math.round(params.tokenUsage.estimatedTotalTokens);
      tokenSource = 'estimated';
    }
  }

  if (!agentId && !model && !provider && totalTokens === null) {
    return null;
  }

  return {
    agentId,
    model,
    provider,
    totalTokens,
    tokenSource: totalTokens === null ? null : tokenSource,
  };
}

export function buildEmailMetadataHeaders(
  metadata?: EmailDeliveryMetadata | null,
): Record<string, string> | undefined {
  if (!metadata) return undefined;

  const headers: Record<string, string> = {};
  if (metadata.agentId) {
    headers[EMAIL_METADATA_HEADERS.agentId] = metadata.agentId;
  }
  if (metadata.model) {
    headers[EMAIL_METADATA_HEADERS.model] = metadata.model;
  }
  if (metadata.provider) {
    headers[EMAIL_METADATA_HEADERS.provider] = metadata.provider;
  }
  if (metadata.totalTokens !== null) {
    headers[EMAIL_METADATA_HEADERS.totalTokens] = String(metadata.totalTokens);
  }
  if (metadata.totalTokens !== null && metadata.tokenSource) {
    headers[EMAIL_METADATA_HEADERS.tokenSource] = metadata.tokenSource;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function parseEmailDeliveryMetadata(
  headers: HeaderLookup | Map<string, unknown> | null | undefined,
): EmailDeliveryMetadata | null {
  const lookup = resolveHeaderLookup(headers);
  if (!lookup) return null;

  const agentId = trimString(
    readHeaderValue(lookup, EMAIL_METADATA_HEADERS.agentId),
  );
  const model = trimString(
    readHeaderValue(lookup, EMAIL_METADATA_HEADERS.model),
  );
  const provider = trimString(
    readHeaderValue(lookup, EMAIL_METADATA_HEADERS.provider),
  );
  const totalTokens = normalizeTokenCount(
    readHeaderValue(lookup, EMAIL_METADATA_HEADERS.totalTokens),
  );
  const tokenSource =
    totalTokens === null
      ? null
      : normalizeTokenSource(
          readHeaderValue(lookup, EMAIL_METADATA_HEADERS.tokenSource),
        );

  if (!agentId && !model && !provider && totalTokens === null) {
    return null;
  }

  return {
    agentId,
    model,
    provider,
    totalTokens,
    tokenSource,
  };
}
