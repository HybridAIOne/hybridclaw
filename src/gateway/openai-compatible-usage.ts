/**
 * Usage recording for OpenAI-compatible completions that call the model
 * directly (client tools, the `regular` decision alias), outside the agent
 * turn that records its own usage.
 *
 * Records the model that served the call, which after provider fallback may
 * differ from the requested one. Does not shape the response's `usage` field.
 */
import type { TokenUsageStats } from '../types/usage.js';
import { resolveUsageCostUsdAfterMetadataRefresh } from '../usage/model-cost.js';
import {
  enqueueTokenUsage,
  readCacheTokenUsage,
} from '../usage/token-usage-buffer.js';

export async function recordOpenAICompatibleUsage(params: {
  sessionId: string;
  agentId: string;
  model: string;
  tokenUsage: TokenUsageStats | undefined;
}): Promise<void> {
  const { tokenUsage } = params;
  const promptTokens = tokenUsage?.apiPromptTokens ?? 0;
  const completionTokens = tokenUsage?.apiCompletionTokens ?? 0;
  enqueueTokenUsage({
    sessionId: params.sessionId,
    agentId: params.agentId,
    model: params.model,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: tokenUsage?.apiTotalTokens ?? promptTokens + completionTokens,
    ...readCacheTokenUsage(tokenUsage),
    costUsd: await resolveUsageCostUsdAfterMetadataRefresh({
      model: params.model,
      tokenUsage,
      usage: { promptTokens, completionTokens },
    }),
  });
}
