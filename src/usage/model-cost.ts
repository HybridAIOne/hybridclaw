import {
  getModelCatalogMetadata,
  refreshModelCatalogMetadata,
} from '../providers/model-catalog.js';
import type { TokenUsageStats } from '../types/usage.js';

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

export interface RoutingCostAttempt extends ModelUsageTokenCounts {
  model: string;
  costUsd?: number;
}

export interface RoutingSavingsEstimate {
  actualCostUsd: number;
  counterfactualCostUsd: number;
  savedUsd: number;
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

export function explicitUsageCostSource(
  tokenUsage?: TokenUsageStats,
): 'reported' | 'estimated' {
  const carrier = tokenUsage as unknown as Record<string, unknown> | undefined;
  return carrier &&
    firstFiniteNonNegativeNumber([
      carrier.costUsd,
      carrier.costUSD,
      carrier.cost_usd,
    ]) !== null
    ? 'reported'
    : 'estimated';
}

/**
 * Native Anthropic usage reports `input_tokens` as the uncached remainder,
 * with cache reads and writes counted separately. OpenAI-style providers
 * (including OpenRouter and HybridAI relays) fold cached tokens into
 * `prompt_tokens`, so the cached share has to be carved out before pricing.
 */
export function promptTokensIncludeCacheTokens(model: string): boolean {
  return !model.trim().toLowerCase().startsWith('anthropic/');
}

export function estimateModelUsageCostUsd(
  params: ModelUsageTokenCounts & { model: string },
): number | null {
  const pricing = getModelCatalogMetadata(params.model).pricingUsdPerToken;
  if (pricing.input == null && pricing.output == null) return null;
  const inputPrice = pricing.input ?? 0;
  const cacheReadTokens = Math.max(0, params.cacheReadTokens ?? 0);
  const cacheWriteTokens = Math.max(0, params.cacheWriteTokens ?? 0);
  const uncachedPromptTokens = promptTokensIncludeCacheTokens(params.model)
    ? Math.max(0, params.promptTokens - cacheReadTokens - cacheWriteTokens)
    : params.promptTokens;
  return (
    uncachedPromptTokens * inputPrice +
    cacheReadTokens * (pricing.cacheRead ?? inputPrice) +
    cacheWriteTokens * (pricing.cacheWrite ?? inputPrice) +
    params.completionTokens * (pricing.output ?? 0)
  );
}

function readCacheTokenCounts(
  tokenUsage: TokenUsageStats | undefined,
  usage: UsageTokenCounts,
): Pick<ModelUsageTokenCounts, 'cacheReadTokens' | 'cacheWriteTokens'> {
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

export function estimateRoutingSavingsUsd(params: {
  referenceModel: string;
  referenceUsage: ModelUsageTokenCounts;
  attempts: RoutingCostAttempt[];
}): RoutingSavingsEstimate | null {
  const counterfactualCostUsd = estimateModelUsageCostUsd({
    ...params.referenceUsage,
    model: params.referenceModel,
  });
  if (counterfactualCostUsd == null) return null;

  let actualCostUsd = 0;
  for (const attempt of params.attempts) {
    const explicitCost = readFiniteNonNegativeNumber(attempt.costUsd);
    const attemptCost = explicitCost ?? estimateModelUsageCostUsd(attempt);
    if (attemptCost == null) return null;
    actualCostUsd += attemptCost;
  }

  return {
    actualCostUsd,
    counterfactualCostUsd,
    savedUsd: counterfactualCostUsd - actualCostUsd,
  };
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
      ...readCacheTokenCounts(params.tokenUsage, params.usage),
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
      ...readCacheTokenCounts(params.tokenUsage, params.usage),
    }) ?? 0
  );
}
