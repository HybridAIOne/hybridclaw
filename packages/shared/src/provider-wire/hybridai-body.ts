/**
 * HybridAI chat-completions request body — the one builder the worker and the
 * gateway (model client and auxiliary calls) use, so a field the worker sends
 * cannot silently go missing on a gateway path.
 *
 * Optional controls appear only when the caller supplies them; reasoning
 * effort is dropped for models that do not support it, and adaptive thinking
 * is sent only when the caller opts in. Pure: the transport,
 * headers, and HybridAI destination checks stay with each caller.
 */
import type { ReasoningEffort } from '@hybridclaw/contracts/reasoning-effort';
import { getSupportedReasoningEfforts } from '../reasoning-effort.ts';
import {
  buildChatCompletionsBody,
  type ChatCompletionsRequestParams,
} from './chat-completions.ts';
import { stripHybridAIModelPrefix } from './model-names.ts';

export interface HybridAIRequestParams extends ChatCompletionsRequestParams {
  chatbotId?: string;
  enableRag?: boolean;
  reasoningEffort?: ReasoningEffort;
  // Worker only (owner call, 2026-11-23): gateway paths drop the signed
  // `anthropic_content` thinking blocks and forward forced tool_choice and
  // small max_tokens, so they stay thinking-free as they were before.
  adaptiveThinking?: boolean;
}

const ADAPTIVE_THINKING_MODEL =
  /^anthropic\/claude-(?:sonnet-(?:4-6|5)|opus-4-(?:6|7|8))(?:$|-)/;

export function buildHybridAIRequestBody(
  params: HybridAIRequestParams,
): Record<string, unknown> {
  const model = stripHybridAIModelPrefix(params.model);
  const body: Record<string, unknown> = {
    ...buildChatCompletionsBody({ ...params, model }),
    // The bot is optional, and RAG searches the bot's knowledge.
    ...(params.chatbotId
      ? { chatbot_id: params.chatbotId, enable_rag: params.enableRag }
      : {}),
  };
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
  if (
    params.adaptiveThinking &&
    ADAPTIVE_THINKING_MODEL.test(model.toLowerCase())
  ) {
    body.thinking = { type: 'adaptive', display: 'summarized' };
  }
  return body;
}
