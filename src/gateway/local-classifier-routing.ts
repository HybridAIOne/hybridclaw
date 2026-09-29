/**
 * Local plugin predictions pass the same closed-tier validation as JEV.
 * This bridge records local cost and cancellation; it never sends a fallback
 * request to a chat provider or changes the execution privacy boundary.
 */
import { evaluateRouting } from '../routing/evaluator.js';
import type { RoutingEvaluatorConfig } from '../routing/evaluator-contract.js';
import { parseJevResponse } from '../routing/jev-adapter.js';
import type { LocalClassifierRegistration } from '../routing/local-classifiers.js';
import { routingTierCriteria, TIER_SELECTION_RULE } from '../routing/policy.js';
import {
  finishRoutingTraceAttempt,
  startRoutingTraceAttempt,
} from '../usage/routing-trace.js';
export async function evaluateLocalClassifier(
  input: {
    text: string;
    signal?: AbortSignal;
    comparison?: boolean;
  },
  registration: LocalClassifierRegistration,
  config: RoutingEvaluatorConfig,
  tiers: { name: string }[],
) {
  const attempt = startRoutingTraceAttempt(
    registration.model,
    'auxiliary',
    'typed-routing-evaluator',
  );
  const result = await evaluateRouting({
    ...input,
    approved: true,
    tiers,
    config: {
      ...config,
      mode: input.comparison ? 'shadow' : 'active',
      model: registration.model,
    },
    classifier: {
      async evaluate({ text, signal }) {
        return parseJevResponse(
          await registration.predict({
            text,
            signal,
            questions: {
              tier: {
                type: 'choice',
                instructions: TIER_SELECTION_RULE,
                criteria: routingTierCriteria(tiers),
              },
            },
          }),
          tiers,
        );
      },
    },
  });
  result.provider = 'local-decision';
  result.model = registration.model;
  result.costUsd = 0;
  finishRoutingTraceAttempt({
    attempt,
    model: registration.model,
    status: result.distributions ? 'success' : 'error',
    durationMs: result.durationMs,
    costUsd: 0,
    costSource: 'estimated',
    inputTokens: result.inputTokens ?? undefined,
    outputTokens: result.outputTokens ?? undefined,
  });
  return result;
}
