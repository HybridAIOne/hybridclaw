import { recordAuditEvent } from '../audit/audit-events.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import type { ChatMessage, TokenUsageStats } from '../types.js';

export interface ModelUsageAuditStats {
  modelCalls: number;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTotalTokens: number;
  apiUsageAvailable: boolean;
  apiPromptTokens: number;
  apiCompletionTokens: number;
  apiTotalTokens: number;
  apiCacheUsageAvailable: boolean;
  apiCacheReadTokens: number;
  apiCacheWriteTokens: number;
}

export function buildModelUsageAuditStats(params: {
  messages: ChatMessage[];
  resultText: string | null | undefined;
  toolCallCount: number;
  tokenUsage?: TokenUsageStats;
}): ModelUsageAuditStats {
  const estimatedPromptTokens =
    params.tokenUsage?.estimatedPromptTokens ||
    estimateTokenCountFromMessages(params.messages);
  const estimatedCompletionTokens =
    params.tokenUsage?.estimatedCompletionTokens ||
    estimateTokenCountFromText(params.resultText || '');
  const estimatedTotalTokens =
    params.tokenUsage?.estimatedTotalTokens ||
    estimatedPromptTokens + estimatedCompletionTokens;
  const apiUsageAvailable = params.tokenUsage?.apiUsageAvailable === true;
  const apiPromptTokens = params.tokenUsage?.apiPromptTokens || 0;
  const apiCompletionTokens = params.tokenUsage?.apiCompletionTokens || 0;
  const apiTotalTokens =
    params.tokenUsage?.apiTotalTokens || apiPromptTokens + apiCompletionTokens;
  const apiCacheUsageAvailable =
    params.tokenUsage?.apiCacheUsageAvailable === true;
  const apiCacheReadTokens = params.tokenUsage?.apiCacheReadTokens || 0;
  const apiCacheWriteTokens = params.tokenUsage?.apiCacheWriteTokens || 0;

  return {
    modelCalls: params.tokenUsage
      ? Math.max(1, params.tokenUsage.modelCalls)
      : 0,
    toolCallCount: params.toolCallCount,
    promptTokens: apiUsageAvailable ? apiPromptTokens : estimatedPromptTokens,
    completionTokens: apiUsageAvailable
      ? apiCompletionTokens
      : estimatedCompletionTokens,
    totalTokens: apiUsageAvailable ? apiTotalTokens : estimatedTotalTokens,
    estimatedPromptTokens,
    estimatedCompletionTokens,
    estimatedTotalTokens,
    apiUsageAvailable,
    apiPromptTokens,
    apiCompletionTokens,
    apiTotalTokens,
    apiCacheUsageAvailable,
    apiCacheReadTokens,
    apiCacheWriteTokens,
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
      toolCallCount: usage.toolCallCount,
      modelCalls: usage.modelCalls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      estimatedPromptTokens: usage.estimatedPromptTokens,
      estimatedCompletionTokens: usage.estimatedCompletionTokens,
      estimatedTotalTokens: usage.estimatedTotalTokens,
      apiUsageAvailable: usage.apiUsageAvailable,
      apiPromptTokens: usage.apiPromptTokens,
      apiCompletionTokens: usage.apiCompletionTokens,
      apiTotalTokens: usage.apiTotalTokens,
      ...(usage.apiCacheUsageAvailable
        ? {
            apiCacheUsageAvailable: usage.apiCacheUsageAvailable,
            apiCacheReadTokens: usage.apiCacheReadTokens,
            apiCacheWriteTokens: usage.apiCacheWriteTokens,
            cacheReadTokens: usage.apiCacheReadTokens,
            cacheReadInputTokens: usage.apiCacheReadTokens,
            cacheWriteTokens: usage.apiCacheWriteTokens,
            cacheWriteInputTokens: usage.apiCacheWriteTokens,
          }
        : {}),
    },
  });
}
