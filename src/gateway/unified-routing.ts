/**
 * Classifies only the current eligible prompt, then feeds the shared tier policy.
 * Local disclosure denials precede transport; classifier failure preserves uncertainty.
 * Neither JEV nor a text model may return an executable model identifier.
 */
import { getRuntimeConfig } from '../config/runtime-config.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import {
  getAvailableModelList,
  getModelCatalogMetadata,
} from '../providers/model-catalog.js';
import { evaluatorDisclosureReason } from '../routing/evaluator.js';
import type { TypedRoutingEvaluation } from '../routing/evaluator-contract.js';
import {
  type RoutingSignals,
  routingTierCriteria,
  TIER_SELECTION_RULE,
  UNKNOWN_SIGNALS,
} from '../routing/policy.js';
import { estimateModelUsageCostUsd } from '../usage/model-cost.js';
import { evaluateConfiguredRouting } from './routing-evaluator.js';

export async function classifyRouting(input: {
  text: string;
  hasPrivateContext?: boolean;
  signal?: AbortSignal;
  model?: string;
  publicSample?: boolean;
  comparison?: boolean;
}) {
  const routing = getRuntimeConfig().routing;
  const model =
    input.model ??
    (routing.concierge.model ||
      getAvailableModelList().find((model) => /gemma.*e4b/i.test(model)) ||
      '');
  const disclosure = evaluatorDisclosureReason({
    ...input,
    approved: !input.comparison || input.publicSample === true,
  });
  const localOnly =
    routing.mode === 'privacy' ||
    Boolean(disclosure && disclosure !== 'public-approval-required');
  let signals = { ...UNKNOWN_SIGNALS };
  const evaluation: TypedRoutingEvaluation = {
    version: 1,
    provider: 'concierge',
    mode: input.comparison ? 'shadow' : 'active',
    model,
    status: 'blocked',
    reason: 'classifier-disabled',
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    distributions: null,
    recommendedTier: null,
    applied: false,
  };
  if (!model)
    return {
      signals,
      evaluation: {
        ...evaluation,
        model: 'rule-based',
        provider: 'rules',
        status: 'evaluated' as const,
        reason: 'configured-tier',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      localOnly,
    };
  if (input.comparison && !input.publicSample)
    return {
      signals,
      evaluation: { ...evaluation, reason: 'public-approval-required' },
      localOnly,
    };
  if (
    localOnly &&
    (model.startsWith('jev/') ||
      getModelCatalogMetadata(model).zone !== 'local')
  )
    return {
      signals,
      evaluation: { ...evaluation, reason: 'local-only-classification' },
      localOnly,
    };
  // Attachments, expanded context and suspected instruction attacks are not classifier input.
  if (disclosure)
    return {
      signals,
      evaluation: { ...evaluation, reason: disclosure },
      localOnly,
    };
  if (model.startsWith('jev/')) {
    const jev = await evaluateConfiguredRouting({
      ...input,
      concierge: !input.comparison,
      playground: input.comparison,
      evaluatorModel: model.slice(4),
    });
    if (jev.status === 'evaluated') signals.tier = jev.recommendedTier;
    return { signals, evaluation: jev, localOnly };
  }
  if (!routing.tiers.length)
    return {
      signals,
      evaluation: { ...evaluation, reason: 'no-tiers' },
      localOnly,
    };
  const started = Date.now();
  try {
    const result = await callAuxiliaryModel({
      task: 'skills_hub',
      traceReason: 'routing-classifier',
      model,
      provider: 'auto',
      allowFallback: false,
      fallbackEnableRag: false,
      timeoutMs: routing.evaluator.timeoutMs,
      maxTokens: 120,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `${TIER_SELECTION_RULE} Return JSON only: {"tier":"<configured tier name>"}. Available tiers: ${JSON.stringify(routingTierCriteria(routing.tiers))}`,
        },
        {
          role: 'user',
          content: `Classify this task for routing; do not perform it.\nTask (JSON string): ${JSON.stringify(input.text)}\nReturn only the JSON object with tier.`,
        },
      ],
    });
    evaluation.model = model;
    evaluation.inputTokens = result.usage?.inputTokens ?? null;
    evaluation.outputTokens = result.usage?.outputTokens ?? null;
    evaluation.costUsd =
      result.usage?.costUsd ??
      (evaluation.inputTokens !== null && evaluation.outputTokens !== null
        ? estimateModelUsageCostUsd({
            model,
            promptTokens: evaluation.inputTokens,
            completionTokens: evaluation.outputTokens,
          })
        : null);
    evaluation.reason = 'classifier-invalid-response';
    const content = result.content.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content);
    const parsed = JSON.parse(fenced ? fenced[1] : content) as RoutingSignals;
    if (
      !parsed ||
      !routing.tiers.some((tier) => tier.name === parsed.tier) ||
      Object.keys(parsed).length !== 1
    )
      throw new Error('invalid-response');
    signals = parsed;
    evaluation.recommendedTier = parsed.tier;
    evaluation.status = 'evaluated';
    evaluation.reason = 'classified';
  } catch {
    evaluation.status = 'fallback';
    if (evaluation.reason !== 'classifier-invalid-response')
      evaluation.reason = 'classifier-failed';
  }
  evaluation.durationMs = Date.now() - started;
  return { signals, evaluation, localOnly };
}
