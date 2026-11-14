/**
 * Worker usage is projected by model before audit, pricing and chargeback.
 * Helpers are separate calls, never extra tokens priced as the primary model.
 * Unlike provider routing, this consumes observed metadata and grants no access;
 * missing reports remain unknown in the routing trace.
 */

import type { ModelCallUsage } from '@hybridclaw/shared/token-usage';
import { primaryTokenUsage } from '@hybridclaw/shared/token-usage';
import { recordAuditEvent } from '../audit/audit-events.js';
import type { UsageAttribution } from '../memory/usage.js';
import {
  getModelCatalogMetadata,
  refreshModelCatalogMetadata,
} from '../providers/model-catalog.js';
import { isLocalBackendType } from '../providers/provider-ids.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import type { ChatMessage } from '../types/api.js';
import type { RoutingTraceAttempt } from '../types/routing-trace.js';
import type { TokenUsageStats } from '../types/usage.js';
import { estimateModelUsageCostUsd } from './model-cost.js';
import {
  finishRoutingTraceAttempt,
  startRoutingTraceAttempt,
} from './routing-trace.js';
import {
  enqueueTokenUsage,
  readCacheTokenUsage,
} from './token-usage-buffer.js';

async function modelCallCost(call: ModelCallUsage): Promise<number | null> {
  if (call.costUsd !== undefined) return call.costUsd;
  if (!call.usage.apiUsageAvailable) return null;
  await refreshModelCatalogMetadata(call.model);
  return estimateModelUsageCostUsd({
    model: call.model,
    promptTokens: call.usage.apiPromptTokens,
    completionTokens: call.usage.apiCompletionTokens,
    ...readCacheTokenUsage(call.usage),
  });
}

export async function recordWorkerAuxiliaryUsage(
  params: UsageAttribution & {
    sessionId: string;
    agentId: string;
    auditRunId: string;
    usages: Array<TokenUsageStats | undefined>;
  },
): Promise<RoutingTraceAttempt[]> {
  const records: RoutingTraceAttempt[] = [];
  const { usages, ...attribution } = params;
  for (const call of usages.flatMap((usage) => usage?.modelUsage ?? [])) {
    if (!call.task) continue;
    const usage = call.usage;
    const costUsd = await modelCallCost(call);
    const known = usage.apiUsageAvailable;
    const local = call.provider && isLocalBackendType(call.provider);
    const attempt: RoutingTraceAttempt = {
      id: records.length + 1,
      kind: 'auxiliary',
      model: call.model,
      zone: local
        ? 'local'
        : (getModelCatalogMetadata(call.model).zone ?? 'cloud'),
      reason: call.task,
      tier: null,
      status: call.status === 'running' ? 'error' : call.status,
      durationMs: call.durationMs,
      modelCalls: usage.modelCalls,
      inputTokens: known ? usage.apiPromptTokens : null,
      outputTokens: known ? usage.apiCompletionTokens : null,
      totalTokens: known ? usage.apiTotalTokens : null,
      cacheReadTokens: usage.apiCacheUsageAvailable
        ? usage.apiCacheReadTokens
        : null,
      cacheWriteTokens: usage.apiCacheUsageAvailable
        ? usage.apiCacheWriteTokens
        : null,
      tokensEstimated: false,
      costUsd,
      costSource:
        call.costUsd !== undefined
          ? 'reported'
          : costUsd !== null
            ? 'estimated'
            : 'unknown',
      usageSource: 'worker',
    };
    records.push(attempt);
    recordAuditEvent({
      sessionId: params.sessionId,
      runId: params.auditRunId,
      event: {
        type: 'model.usage',
        provider: call.provider,
        model: call.model,
        task: call.task,
        durationMs: call.durationMs,
        toolCallCount: 0,
        ...buildTokenUsageAuditPayload([], null, usage),
        costUsd,
      },
    });
    enqueueTokenUsage({
      ...attribution,
      model: call.model,
      inputTokens: known ? usage.apiPromptTokens : 0,
      outputTokens: known ? usage.apiCompletionTokens : 0,
      totalTokens: known ? usage.apiTotalTokens : 0,
      ...readCacheTokenUsage(usage),
      toolCalls: 0,
      ...(costUsd !== null ? { costUsd } : {}),
      routeReason: call.task,
    });
    const traceAttempt = startRoutingTraceAttempt(
      call.model,
      'auxiliary',
      call.task,
    );
    if (traceAttempt) {
      traceAttempt.usageSource = 'worker';
      traceAttempt.zone = attempt.zone;
      finishRoutingTraceAttempt({
        ...attempt,
        attempt: traceAttempt,
        status: attempt.status === 'running' ? 'error' : attempt.status,
        tier: attempt.tier ?? undefined,
        inputTokens: attempt.inputTokens ?? undefined,
        outputTokens: attempt.outputTokens ?? undefined,
        totalTokens: attempt.totalTokens ?? undefined,
        cacheReadTokens: attempt.cacheReadTokens ?? undefined,
        cacheWriteTokens: attempt.cacheWriteTokens ?? undefined,
        costUsd: costUsd ?? undefined,
        costSource: attempt.costSource,
      });
    }
  }
  return records;
}

export function buildTokenUsageAuditPayload(
  messages: ChatMessage[],
  resultText: string | null | undefined,
  tokenUsage?: TokenUsageStats,
) {
  const observedCalls = tokenUsage?.modelUsage !== undefined;
  tokenUsage = tokenUsage ? primaryTokenUsage(tokenUsage) : undefined;
  const promptChars = messages.reduce((total, message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    return total + content.length;
  }, 0);
  const completionChars = (resultText || '').length;

  const fallbackEstimatedPromptTokens =
    estimateTokenCountFromMessages(messages);
  const fallbackEstimatedCompletionTokens = estimateTokenCountFromText(
    resultText || '',
  );
  const estimatedPromptTokens =
    (observedCalls ? tokenUsage?.estimatedPromptTokens : undefined) ??
    (tokenUsage?.estimatedPromptTokens || fallbackEstimatedPromptTokens);
  const estimatedCompletionTokens =
    (observedCalls ? tokenUsage?.estimatedCompletionTokens : undefined) ??
    (tokenUsage?.estimatedCompletionTokens ||
      fallbackEstimatedCompletionTokens);
  const estimatedTotalTokens =
    tokenUsage?.estimatedTotalTokens ||
    estimatedPromptTokens + estimatedCompletionTokens;

  const apiUsageAvailable = tokenUsage?.apiUsageAvailable === true;
  const apiPromptTokens = tokenUsage?.apiPromptTokens || 0;
  const apiCompletionTokens = tokenUsage?.apiCompletionTokens || 0;
  const apiTotalTokens =
    tokenUsage?.apiTotalTokens || apiPromptTokens + apiCompletionTokens;
  const apiCacheUsageAvailable = tokenUsage?.apiCacheUsageAvailable === true;
  const apiCacheReadTokens = tokenUsage?.apiCacheReadTokens || 0;
  const apiCacheWriteTokens = tokenUsage?.apiCacheWriteTokens || 0;
  const promptTokens = apiUsageAvailable
    ? apiPromptTokens
    : estimatedPromptTokens;
  const completionTokens = apiUsageAvailable
    ? apiCompletionTokens
    : estimatedCompletionTokens;
  const totalTokens = apiUsageAvailable ? apiTotalTokens : estimatedTotalTokens;

  return {
    modelCalls: tokenUsage
      ? Math.max(apiTotalTokens > 0 ? 1 : 0, tokenUsage.modelCalls)
      : 0,
    promptChars,
    completionChars,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedPromptTokens,
    estimatedCompletionTokens,
    estimatedTotalTokens,
    apiUsageAvailable,
    apiPromptTokens,
    apiCompletionTokens,
    apiTotalTokens,
    ...(tokenUsage?.performanceSamples?.length
      ? { performanceSamples: tokenUsage.performanceSamples }
      : {}),
    ...(apiCacheUsageAvailable
      ? {
          apiCacheUsageAvailable,
          apiCacheReadTokens,
          apiCacheWriteTokens,
          cacheReadTokens: apiCacheReadTokens,
          cacheReadInputTokens: apiCacheReadTokens,
          cacheWriteTokens: apiCacheWriteTokens,
          cacheWriteInputTokens: apiCacheWriteTokens,
        }
      : {}),
  };
}
