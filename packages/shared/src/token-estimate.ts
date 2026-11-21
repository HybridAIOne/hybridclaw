/**
 * The one pre-call token estimate, shared by gateway history budgeting and
 * compaction, the worker context guard, and helper-call cost estimates. The
 * gateway and the worker must count the same history the same way, or the
 * gateway sends a window that the worker immediately compacts.
 *
 * Over-counting is preferred to under-counting: every field that can reach a
 * provider is counted, even when a provider sends replay blocks in place of
 * `content`. NOT provider-reported usage (`token-usage.ts`); estimates never
 * replace reported counts.
 */
import type { ChatMessage } from '@hybridclaw/contracts/agent-io';
import { chatContentText } from './message-text.ts';

export const CHARS_PER_TOKEN = 4;
// Tool output (JSON, code, logs) tokenizes denser than prose.
export const TOOL_RESULT_CHARS_PER_TOKEN = 2;
// Agent decision, 2026-09-29: reserve 4k tokens per selected page for pixels
// and native PDF text; exact usage remains provider-reported.
const VISUAL_PAGE_TOKENS = 4_000;
const MESSAGE_FRAMING_TOKENS = 4;
const REQUEST_PRIMING_TOKENS = 2;

export type EstimatedMessage = Pick<ChatMessage, 'role' | 'content'> &
  Partial<
    Pick<
      ChatMessage,
      | 'tool_calls'
      | 'tool_call_id'
      | 'anthropic_content'
      | 'openai_response_items'
      | 'visualAttachments'
    >
  >;

export type TokenEstimateCache = WeakMap<EstimatedMessage, number>;

export function createTokenEstimateCache(): TokenEstimateCache {
  return new WeakMap();
}

function estimateWithRatio(text: unknown, charsPerToken: number): number {
  if (typeof text !== 'string' || !text) return 0;
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

export function estimateTextTokens(text: unknown): number {
  return estimateWithRatio(text, CHARS_PER_TOKEN);
}

export function estimateToolResultTokens(text: unknown): number {
  return estimateWithRatio(text, TOOL_RESULT_CHARS_PER_TOKEN);
}

function estimateJsonTokens(value: unknown): number {
  return value ? estimateTextTokens(JSON.stringify(value)) : 0;
}

export function estimateChatMessageTokens(
  message: EstimatedMessage,
  cache?: TokenEstimateCache,
): number {
  const cached = cache?.get(message);
  if (cached !== undefined) return cached;

  const text = chatContentText(message.content, { mediaPlaceholders: true });
  let total = MESSAGE_FRAMING_TOKENS + estimateTextTokens(message.role);
  total +=
    message.role === 'tool'
      ? estimateToolResultTokens(text)
      : estimateTextTokens(text);
  total += estimateJsonTokens(message.tool_calls);
  total += estimateTextTokens(message.tool_call_id);
  total += estimateJsonTokens(message.anthropic_content);
  total += estimateJsonTokens(message.openai_response_items);
  for (const attachment of message.visualAttachments ?? []) {
    total += (attachment.pages.length || 1) * VISUAL_PAGE_TOKENS;
  }

  cache?.set(message, total);
  return total;
}

export function estimateMessageTokens(
  messages: readonly EstimatedMessage[],
  cache?: TokenEstimateCache,
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let total = REQUEST_PRIMING_TOKENS;
  for (const message of messages) {
    total += estimateChatMessageTokens(message, cache);
  }
  return total;
}
