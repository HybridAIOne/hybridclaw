/**
 * Local disclosure policy gates every external classification before transport.
 * Callers must grant disclosure through admin-approved samples or an enabled
 * cloud concierge. Prompt content cannot grant permission. This is not a PII guarantee.
 */
import type {
  RoutingEvaluatorConfig,
  TypedRoutingEvaluation,
} from './evaluator-contract.js';
import type { TypedClassifier } from './jev-adapter.js';
export function evaluatorDisclosureReason(input: {
  text: string;
  approved: boolean;
  hasPrivateContext?: boolean;
}): string | null {
  if (input.hasPrivateContext) return 'attachments-or-context';
  if (!input.text.trim() || input.text.length > 4000)
    return 'input-out-of-bounds';
  // Defense in depth only: absence of these signals never grants external access.
  if (
    /\b(confidential|private|internal.only|secret|vertraulich|geheim|password|api.?key|salary|patient|ssn|personal data)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d[\d ()+-]{7,}\d\b|-----BEGIN|\b(ignore|override|bypass).{0,50}\b(instructions|policy|rules|routing)\b/is.test(
      input.text,
    )
  )
    return 'local-sensitive-or-instruction-signal';
  return input.approved ? null : 'public-approval-required';
}
export async function evaluateRouting(input: {
  text: string;
  approved: boolean;
  hasPrivateContext?: boolean;
  config: RoutingEvaluatorConfig;
  tiers: { name: string }[];
  classifier?: TypedClassifier;
  signal?: AbortSignal;
}): Promise<TypedRoutingEvaluation> {
  const started = Date.now();
  const result: TypedRoutingEvaluation = {
    version: 1,
    provider: 'jev',
    mode: input.config.mode === 'active' ? 'active' : 'shadow',
    status: 'blocked',
    reason: 'disabled',
    model: input.config.model,
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    distributions: null,
    recommendedTier: null,
    applied: false,
  };
  if (input.config.mode === 'off') return result;
  const blocked = evaluatorDisclosureReason(input);
  if (blocked) return { ...result, reason: blocked };
  if (!input.classifier)
    return { ...result, status: 'fallback', reason: 'credential-missing' };
  if (!input.tiers.length) return { ...result, reason: 'no-tiers' };
  const timeout = AbortSignal.timeout(input.config.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  try {
    const response = await input.classifier.evaluate({
      text: input.text,
      model: input.config.model,
      tiers: input.tiers,
      signal,
    });
    Object.assign(result, response, { status: 'evaluated' });
    const score = response.distributions.tier;
    if (!input.tiers.some((tier) => tier.name === score.choice))
      throw new Error('invalid-response');
    if (score.confidence < input.config.minConfidence) {
      result.status = 'fallback';
      result.reason = 'low-confidence';
    } else {
      result.recommendedTier = score.choice;
      result.reason = 'tier-recommendation';
    }
  } catch (error) {
    result.status = 'fallback';
    result.reason = signal.aborted
      ? 'timeout-or-cancelled'
      : error instanceof Error && error.message === 'invalid-response'
        ? 'invalid-response'
        : error instanceof Error &&
            /^provider-http-[1-5][0-9]{2}$/.test(error.message)
          ? error.message
          : 'provider-error';
  }
  result.durationMs = Date.now() - started;
  return result;
}
