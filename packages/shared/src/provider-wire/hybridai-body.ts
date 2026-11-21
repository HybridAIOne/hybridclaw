/**
 * HybridAI chat-completions request body — the one builder the worker and the
 * gateway (model client and auxiliary calls) use, so a field the worker sends
 * cannot silently go missing on a gateway path.
 *
 * Optional controls appear only when the caller supplies them; reasoning
 * effort is dropped for models that do not support it. Pure: the transport,
 * headers, and HybridAI destination checks stay with each caller.
 */
import type { ReasoningEffort } from '@hybridclaw/contracts/reasoning-effort';
import { stripHybridAIModelPrefix } from '../model-names.ts';
import { getSupportedReasoningEfforts } from '../reasoning-effort.ts';

export interface HybridAIRequestParams {
  model: string;
  messages: unknown[];
  chatbotId?: string;
  enableRag?: boolean;
  tools: unknown[];
  toolChoice?: unknown;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
}

const ADAPTIVE_THINKING_MODEL =
  /^anthropic\/claude-(?:sonnet-(?:4-6|5)|opus-4-(?:6|7|8))(?:$|-)/;

export function buildHybridAIRequestBody(
  params: HybridAIRequestParams,
): Record<string, unknown> {
  const model = stripHybridAIModelPrefix(params.model);
  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
    // The bot is optional, and RAG searches the bot's knowledge.
    ...(params.chatbotId
      ? { chatbot_id: params.chatbotId, enable_rag: params.enableRag }
      : {}),
  };
  if (params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = params.toolChoice || 'auto';
  }
  if (
    typeof params.maxTokens === 'number' &&
    Number.isFinite(params.maxTokens) &&
    params.maxTokens > 0
  ) {
    body.max_tokens = Math.floor(params.maxTokens);
  }
  const reasoningEffort =
    params.reasoningEffort &&
    getSupportedReasoningEfforts('hybridai', model).includes(
      params.reasoningEffort,
    )
      ? params.reasoningEffort
      : undefined;
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
    body.chat_template_kwargs = { enable_thinking: reasoningEffort !== 'none' };
  }
  if (ADAPTIVE_THINKING_MODEL.test(model.toLowerCase())) {
    body.thinking = { type: 'adaptive', display: 'summarized' };
  }
  return body;
}
