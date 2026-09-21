/**
 * Admin comparison runs two classifiers against one explicitly public sample.
 * It never dispatches an agent or changes routing settings. The LLM uses the
 * concierge urgency contract; JEV uses capability, so agreement is not accuracy.
 */
import { getRuntimeConfig } from '../config/runtime-config.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { evaluatorDisclosureReason } from '../routing/evaluator.js';
import { captureRoutingTrace } from '../usage/routing-trace.js';
import { evaluateConfiguredRouting } from './routing-evaluator.js';

export interface ConciergeComparison {
  model: string;
  status: 'evaluated' | 'blocked' | 'fallback';
  decision: string;
  selectedModel: string | null;
  tier: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
export async function compareRouting(input: {
  text: string;
  publicSample: boolean;
  model: string;
}) {
  const routing = getRuntimeConfig().routing;
  const llm: ConciergeComparison = {
    model: input.model,
    status: 'blocked',
    decision: 'public-approval-required',
    selectedModel: null,
    tier: null,
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
  const blocked = evaluatorDisclosureReason({
    text: input.text,
    approved: input.publicSample,
  });
  const classify = async () => {
    if (blocked) {
      llm.decision = blocked;
      return llm;
    }
    const started = Date.now();
    const { trace } = await captureRoutingTrace(async () => {
      try {
        const result = await callAuxiliaryModel({
          task: 'skills_hub',
          provider: 'auto',
          model: input.model,
          allowFallback: false,
          fallbackEnableRag: false,
          maxTokens: 80,
          temperature: 0,
          timeoutMs: 5_000,
          messages: [
            {
              role: 'system',
              content:
                'You are a routing concierge for HybridClaw. Decide whether the user should be asked about urgency, or whether the urgency is already clear from the request. Respond with JSON only. Valid shapes: {"decision":"ask_user"} or {"decision":"pick_profile","profile":"asap"} or {"decision":"pick_profile","profile":"balanced"} or {"decision":"pick_profile","profile":"no_hurry"}. Choose pick_profile only when urgency is explicit in the request.',
            },
            { role: 'user', content: input.text },
          ],
        });
        llm.model = result.model;
        llm.inputTokens = result.usage?.inputTokens ?? null;
        llm.outputTokens = result.usage?.outputTokens ?? null;
        const decision = JSON.parse(result.content) as {
          decision?: string;
          profile?: string;
        };
        if (decision?.decision === 'ask_user') llm.decision = 'ask-user';
        else if (
          decision?.decision === 'pick_profile' &&
          ['asap', 'balanced', 'no_hurry'].includes(decision.profile ?? '')
        ) {
          llm.decision = decision.profile as string;
          const profile =
            decision.profile === 'no_hurry'
              ? 'noHurry'
              : (decision.profile as 'asap' | 'balanced');
          llm.selectedModel = routing.concierge.profiles[profile];
          llm.tier =
            routing.tiers.find((tier) =>
              tier.models.includes(llm.selectedModel ?? ''),
            )?.name ?? null;
        } else throw new Error('invalid-response');
        llm.status = 'evaluated';
      } catch {
        llm.status = 'fallback';
        llm.decision = 'classifier-failed';
      }
    });
    llm.durationMs = Date.now() - started;
    llm.costUsd =
      trace.attempts.length &&
      trace.attempts.every((attempt) => attempt.costUsd !== null)
        ? trace.attempts.reduce(
            (sum, attempt) => sum + (attempt.costUsd ?? 0),
            0,
          )
        : null;
    return llm;
  };
  const [jev, concierge] = await Promise.all([
    evaluateConfiguredRouting({
      text: input.text,
      publicSample: input.publicSample,
      playground: true,
    }),
    classify(),
  ]);
  return { jev, concierge };
}
export type RoutingComparison = Awaited<ReturnType<typeof compareRouting>>;
