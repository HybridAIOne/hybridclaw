/**
 * Compares classifiers against the same prompt and the same tier policy.
 * It never executes a route or writes configuration; public consent gates both calls.
 */
import { getRuntimeConfig } from '../config/runtime-config.js';
import { getModelCatalogMetadata } from '../providers/model-catalog.js';
import { selectRoutingPolicy } from '../routing/policy.js';
import { captureRoutingTrace } from '../usage/routing-trace.js';
import { classifyRouting } from './unified-routing.js';

export async function compareRouting(input: {
  text: string;
  publicSample: boolean;
  model: string;
}) {
  const config = getRuntimeConfig().routing;
  async function evaluate(model: string) {
    const { result, trace } = await captureRoutingTrace(() =>
      classifyRouting({ ...input, model, comparison: true }),
    );
    const decision = selectRoutingPolicy({
      config: { ...config, enabled: true },
      ...result,
      metadata: getModelCatalogMetadata,
    });
    const valid = result.evaluation.status === 'evaluated';
    return {
      ...result.evaluation,
      signals: result.signals,
      recommendedTier: valid ? decision.ladder.startTier : null,
      selectedModel: valid
        ? (decision.ladder.tiers[decision.ladder.startIndex]?.models[0] ?? null)
        : null,
      decision: valid ? decision.reason : result.evaluation.reason,
      costUsd:
        trace.attempts.length &&
        trace.attempts.every((attempt) => attempt.costUsd !== null)
          ? trace.attempts.reduce(
              (sum, attempt) => sum + (attempt.costUsd ?? 0),
              0,
            )
          : result.evaluation.costUsd,
    };
  }
  const [jev, concierge] = await Promise.all([
    evaluate(`jev/${config.evaluator.model}`),
    evaluate(input.model),
  ]);
  return { jev, concierge };
}
export type RoutingComparison = Awaited<ReturnType<typeof compareRouting>>;
