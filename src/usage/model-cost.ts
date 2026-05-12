import {
  getModelCatalogMetadata,
  refreshModelCatalogMetadata,
} from '../providers/model-catalog.js';
import type { TokenUsageStats } from '../types/usage.js';

interface UsageTokenCounts {
  promptTokens?: unknown;
  completionTokens?: unknown;
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
  const costCarrier = tokenUsage as unknown as Record<string, unknown>;
  return firstFiniteNonNegativeNumber([
    costCarrier.costUsd,
    costCarrier.costUSD,
    costCarrier.cost_usd,
    costCarrier.estimatedCostUsd,
    costCarrier.estimated_cost_usd,
  ]);
}

export function estimateModelUsageCostUsd(params: {
  model: string;
  promptTokens: number;
  completionTokens: number;
}): number | null {
  const pricing = getModelCatalogMetadata(params.model).pricingUsdPerToken;
  if (pricing.input == null && pricing.output == null) return null;
  return (
    params.promptTokens * (pricing.input ?? 0) +
    params.completionTokens * (pricing.output ?? 0)
  );
}

export function resolveUsageCostUsd(params: {
  model: string;
  tokenUsage?: TokenUsageStats;
  usage: UsageTokenCounts;
}): number {
  const explicitCost = extractExplicitUsageCostUsd(params.tokenUsage);
  if (explicitCost != null) return explicitCost;

  const promptTokens = readFiniteNonNegativeNumber(params.usage.promptTokens);
  const completionTokens = readFiniteNonNegativeNumber(
    params.usage.completionTokens,
  );
  if (promptTokens == null || completionTokens == null) return 0;

  return (
    estimateModelUsageCostUsd({
      model: params.model,
      promptTokens,
      completionTokens,
    }) ?? 0
  );
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
    }) ?? 0
  );
}
