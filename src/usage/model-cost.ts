/**
 * Primary-model pricing excludes helper counters and prefers reported USD charges.
 * Missing nonzero price components remain unknown to the estimator.
 * Unlike billing storage, this projects metadata and never invokes inference.
 */
import { readReportedUsageCost } from '@hybridclaw/shared/reported-usage-cost';
import { primaryTokenUsage } from '@hybridclaw/shared/token-usage';
import {
  getModelCatalogMetadata,
  refreshModelCatalogMetadata,
} from '../providers/model-catalog.js';
import type { RoutingTraceAttempt } from '../types/routing-trace.js';
import type { TokenUsageStats } from '../types/usage.js';
import { promptTokensIncludeCacheTokens } from './cache-accounting.js';

export { promptTokensIncludeCacheTokens };

interface UsageTokenCounts {
  promptTokens?: unknown;
  completionTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
}

export interface ModelUsageTokenCounts {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

function readFiniteNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function firstFiniteNonNegativeNumber(values: unknown[]): number | null {
  for (const value of values) {
    const parsed = readFiniteNonNegativeNumber(value);
    if (parsed != null) return parsed;
  }
  return null;
}

export function extractExplicitUsageCostUsd(
  tokenUsage?: TokenUsageStats,
): number | null {
  if (!tokenUsage) return null;
  const costCarrier = primaryTokenUsage(tokenUsage) as unknown as Record<
    string,
    unknown
  >;
  return firstFiniteNonNegativeNumber([
    readReportedUsageCost(costCarrier),
    costCarrier.estimatedCostUsd,
    costCarrier.estimated_cost_usd,
  ]);
}

export function explicitUsageCostSource(
  tokenUsage?: TokenUsageStats,
): RoutingTraceAttempt['costSource'] {
  if (
    tokenUsage?.modelUsage?.some(
      (call) =>
        !call.task &&
        !call.usage.apiUsageAvailable &&
        call.costUsd === undefined,
    )
  )
    return 'unknown';
  return tokenUsage &&
    readReportedUsageCost(primaryTokenUsage(tokenUsage)) !== null
    ? 'reported'
    : 'estimated';
}

export function estimateModelUsageCostUsd(
  params: ModelUsageTokenCounts & { model: string },
): number | null {
  const pricing = getModelCatalogMetadata(params.model).pricingUsdPerToken;
  if (
    [
      pricing.input,
      pricing.output,
      pricing.cacheRead,
      pricing.cacheWrite,
    ].every((price) => price == null)
  )
    return null;
  const inputPrice = pricing.input;
  const cacheReadTokens = Math.max(0, params.cacheReadTokens ?? 0);
  const cacheWriteTokens = Math.max(0, params.cacheWriteTokens ?? 0);
  const uncachedPromptTokens = promptTokensIncludeCacheTokens(params.model)
    ? Math.max(0, params.promptTokens - cacheReadTokens - cacheWriteTokens)
    : params.promptTokens;
  const components = [
    [uncachedPromptTokens, inputPrice],
    [cacheReadTokens, pricing.cacheRead ?? inputPrice],
    [cacheWriteTokens, pricing.cacheWrite ?? inputPrice],
    [params.completionTokens, pricing.output],
  ] as const;
  if (components.some(([tokens, price]) => tokens > 0 && price == null))
    return null;
  return components.reduce(
    (sum, [tokens, price]) => sum + tokens * (price ?? 0),
    0,
  );
}

function readCacheTokenCounts(
  tokenUsage: TokenUsageStats | undefined,
  usage: UsageTokenCounts,
): Pick<ModelUsageTokenCounts, 'cacheReadTokens' | 'cacheWriteTokens'> {
  tokenUsage = tokenUsage ? primaryTokenUsage(tokenUsage) : undefined;
  if (tokenUsage?.apiCacheUsageAvailable) {
    return {
      cacheReadTokens: tokenUsage.apiCacheReadTokens,
      cacheWriteTokens: tokenUsage.apiCacheWriteTokens,
    };
  }
  return {
    cacheReadTokens: readFiniteNonNegativeNumber(usage.cacheReadTokens),
    cacheWriteTokens: readFiniteNonNegativeNumber(usage.cacheWriteTokens),
  };
}

export async function resolveUsageCostUsdAfterMetadataRefresh(params: {
  model: string;
  tokenUsage?: TokenUsageStats;
  usage: UsageTokenCounts;
}): Promise<number> {
  const explicitCost = extractExplicitUsageCostUsd(params.tokenUsage);
  if (explicitCost != null) return explicitCost;

  const promptTokens = readFiniteNonNegativeNumber(params.usage.promptTokens);
  const completionTokens = readFiniteNonNegativeNumber(
    params.usage.completionTokens,
  );
  if (promptTokens == null || completionTokens == null) return 0;

  await refreshModelCatalogMetadata(params.model);
  return (
    estimateModelUsageCostUsd({
      model: params.model,
      promptTokens,
      completionTokens,
      ...readCacheTokenCounts(params.tokenUsage, params.usage),
    }) ?? 0
  );
}
