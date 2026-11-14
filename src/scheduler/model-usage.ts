/**
 * Scheduled usage reuses the worker's per-model audit projection.
 * Adds tool counts and timestamps; helpers are never repriced as the primary.
 * Unlike chargeback persistence, this only shapes and appends usage evidence.
 */

import { recordAuditEvent } from '../audit/audit-events.js';
import type { ChatMessage } from '../types/api.js';
import type { TokenUsageStats } from '../types/usage.js';
import { buildTokenUsageAuditPayload } from '../usage/worker-model-usage.js';

export type ModelUsageAuditStats = Omit<
  ReturnType<typeof buildTokenUsageAuditPayload>,
  'apiCacheUsageAvailable'
> & {
  toolCallCount: number;
  apiCacheUsageAvailable: boolean;
  apiCacheReadTokens: number;
  apiCacheWriteTokens: number;
};

export function buildModelUsageAuditStats(params: {
  messages: ChatMessage[];
  resultText: string | null | undefined;
  toolCallCount: number;
  tokenUsage?: TokenUsageStats;
}): ModelUsageAuditStats {
  const usage = buildTokenUsageAuditPayload(
    params.messages,
    params.resultText,
    params.tokenUsage,
  );
  return {
    ...usage,
    toolCallCount: params.toolCallCount,
    apiCacheUsageAvailable: usage.apiCacheUsageAvailable ?? false,
    apiCacheReadTokens: usage.apiCacheReadTokens ?? 0,
    apiCacheWriteTokens: usage.apiCacheWriteTokens ?? 0,
  };
}

export function recordModelUsageAuditEvent(params: {
  sessionId: string;
  runId: string;
  provider: string;
  model: string;
  startedAt: number;
  usage: ModelUsageAuditStats;
}): void {
  const { usage } = params;
  recordAuditEvent({
    sessionId: params.sessionId,
    runId: params.runId,
    event: {
      type: 'model.usage',
      provider: params.provider,
      model: params.model,
      durationMs: Date.now() - params.startedAt,
      ...usage,
    },
  });
}
