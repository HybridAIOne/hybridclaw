/**
 * Bridges opt-in evaluation to runtime settings and per-turn accounting.
 * Public samples or an enabled cloud concierge grant disclosure; local denials
 * apply before credentials or transport are accessed. It returns
 * evidence only; the chat runtime decides whether an existing route may change.
 */
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  evaluateRouting,
  evaluatorDisclosureReason,
} from '../routing/evaluator.js';
import { createJevClassifier } from '../routing/jev-adapter.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import {
  finishRoutingTraceAttempt,
  startRoutingTraceAttempt,
} from '../usage/routing-trace.js';
export async function evaluateConfiguredRouting(input: {
  text: string;
  hasPrivateContext?: boolean;
  signal?: AbortSignal;
  playground?: boolean;
  concierge?: boolean;
  publicSample?: boolean;
}) {
  const routing = getRuntimeConfig().routing;
  const config = input.concierge
    ? {
        ...routing.evaluator,
        mode: 'active' as const,
        model: routing.concierge.model.slice(4),
      }
    : input.playground
      ? { ...routing.evaluator, mode: 'shadow' as const }
      : routing.evaluator;
  const approved = input.concierge
    ? routing.concierge.enabled && routing.concierge.model.startsWith('jev/')
    : input.playground
      ? input.publicSample === true
      : config.publicPrompts.includes(input.text.trim());
  const eligible =
    config.mode !== 'off' && !evaluatorDisclosureReason({ ...input, approved });
  const key = eligible
    ? readStoredRuntimeSecret('JEV_API_KEY') || process.env.JEV_API_KEY?.trim()
    : undefined;
  const model = `jev/${config.model}`;
  const attempt =
    eligible && key
      ? startRoutingTraceAttempt(model, 'auxiliary', 'typed-routing-evaluator')
      : undefined;
  const result = await evaluateRouting({
    ...input,
    config,
    approved,
    tiers: routing.tiers,
    classifier: key ? createJevClassifier(key) : undefined,
  });
  if (attempt)
    finishRoutingTraceAttempt({
      attempt,
      model,
      status: result.status === 'evaluated' ? 'success' : 'error',
      durationMs: result.durationMs,
      inputTokens: result.inputTokens ?? undefined,
      outputTokens: result.outputTokens ?? undefined,
      totalTokens:
        result.inputTokens !== null && result.outputTokens !== null
          ? result.inputTokens + result.outputTokens
          : undefined,
    });
  return result;
}

export function isJevAvailable(): boolean {
  return Boolean(
    readStoredRuntimeSecret('JEV_API_KEY') || process.env.JEV_API_KEY?.trim(),
  );
}
