/**
 * What a task cost the user, and what a big one is likely to cost: euros at
 * HybridAI's wallet prices (a free-tier model costs nothing), and the model
 * requests it takes, which count against the account's request allowance.
 *
 * The cost of a reply comes from the routing trace stored with it, never from
 * its text. NOT billing: the HybridAI wallet is the record; these are the
 * runtime's own figures from the same price list.
 */
import { isDiscoveredHybridAIFreeTierModel } from '../providers/hybridai-discovery.js';
import { getModelCatalogMetadata } from '../providers/model-catalog.js';
import { MODEL_METADATA_USD_TO_EUR } from '../providers/model-metadata.js';
import type { RoutingTrace } from '../types/routing-trace.js';

export interface TaskCost {
  /** Euros the task cost; null when a model it used has no known price. */
  eur: number | null;
  /** Every model it used is free. */
  free: boolean;
  /** Model requests it made; null for a trace that did not count them. */
  requests: number | null;
}

export interface TaskCostEstimate {
  /** The likely range in euros; both 0 on a free model. */
  low: number;
  high: number;
  free: boolean;
  /** The model requests the task is expected to take. */
  requests: number;
}

type FreeTierCheck = (model: string) => boolean;

const toEur = (usd: number) => usd / MODEL_METADATA_USD_TO_EUR.usdPerEur;

export function taskCostFromRoutingTrace(
  trace: RoutingTrace | null | undefined,
  isFree: FreeTierCheck = isDiscoveredHybridAIFreeTierModel,
): TaskCost | null {
  const attempts = trace?.attempts ?? [];
  if (!attempts.length) return null;
  let usd: number | null = 0;
  let requests: number | null = 0;
  let free = true;
  for (const attempt of attempts) {
    requests =
      requests === null || attempt.modelCalls === undefined
        ? null
        : requests + attempt.modelCalls;
    if (isFree(attempt.model)) continue;
    free = false;
    if (attempt.costUsd !== null) {
      if (usd !== null) usd += attempt.costUsd;
    } else if (attempt.zone !== 'local') {
      // A model on the user's own machine bills no one.
      usd = null;
    }
  }
  return {
    eur: usd === null ? null : Math.round(toEur(usd) * 10_000) / 10_000,
    free,
    requests,
  };
}

// 2026-10-09: what one step of a tool loop adds to the context, what the model
// writes per step, and how much of the re-sent context a provider's prompt
// cache serves. The range around the middle covers lighter and heavier steps.
const STEP_CONTEXT_GROWTH_TOKENS = 1_500;
const STEP_OUTPUT_TOKENS = 500;
const CACHED_INPUT_SHARE = 0.8;
const DEFAULT_CONTEXT_TOKENS = 12_000;
const LOW_FACTOR = 0.6;
const HIGH_FACTOR = 1.6;

/** The cost of a task of `steps` model requests from the current context. */
export function estimateTaskCost(params: {
  model: string;
  steps: number;
  contextTokens: number | null;
  isFree?: FreeTierCheck;
}): TaskCostEstimate | null {
  const steps = Math.max(1, Math.round(params.steps));
  if ((params.isFree ?? isDiscoveredHybridAIFreeTierModel)(params.model)) {
    return { low: 0, high: 0, free: true, requests: steps };
  }
  const pricing = getModelCatalogMetadata(params.model).pricingUsdPerToken;
  if (pricing.input == null || pricing.output == null) return null;
  const context = Math.min(
    Math.max(params.contextTokens ?? DEFAULT_CONTEXT_TOKENS, 2_000),
    1_000_000,
  );
  const input =
    steps * context + (STEP_CONTEXT_GROWTH_TOKENS * steps * (steps - 1)) / 2;
  const inputPrice =
    (1 - CACHED_INPUT_SHARE) * pricing.input +
    CACHED_INPUT_SHARE * (pricing.cacheRead ?? pricing.input);
  const middle = toEur(
    input * inputPrice + steps * STEP_OUTPUT_TOKENS * pricing.output,
  );
  return {
    low: Math.floor(middle * LOW_FACTOR * 100) / 100,
    high: Math.max(0.01, Math.ceil(middle * HIGH_FACTOR * 100) / 100),
    free: false,
    requests: steps,
  };
}

// The estimate a turn's `estimate_cost` call gave, until the turn ends and
// shows it with the reply. Turns of one session run one at a time.
const pendingEstimates = new Map<string, TaskCostEstimate>();

export function rememberTaskCostEstimate(
  sessionId: string,
  estimate: TaskCostEstimate,
): void {
  pendingEstimates.set(sessionId, estimate);
}

export function takeTaskCostEstimate(
  sessionId: string,
): TaskCostEstimate | undefined {
  const estimate = pendingEstimates.get(sessionId);
  pendingEstimates.delete(sessionId);
  return estimate;
}
