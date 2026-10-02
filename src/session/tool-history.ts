/**
 * Stored tool exchanges belong to their final assistant message and expand as
 * one unit for replay and compaction. This is conversation storage, not the
 * audit trail; only validated tool exchanges may introduce tool-role messages.
 * A user message expands with the dynamic context it was sent with, so replay
 * reproduces the earlier request byte for byte.
 */
import {
  toolResultForHistory,
  validateToolHistory,
} from '../../container/shared/tool-history.js';
import { redactCredentialSecrets } from '../security/redact.js';
import type { ChatMessage } from '../types/api.js';

export function transformToolHistory(
  value: unknown,
  transform: (text: string) => string,
): ChatMessage[] {
  return validateToolHistory(value).map((message) => ({
    ...message,
    content:
      typeof message.content === 'string'
        ? transform(message.content)
        : message.content,
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            ...call,
            function: {
              ...call.function,
              arguments: transform(call.function.arguments),
            },
          })),
        }
      : {}),
    ...(message.anthropic_content
      ? {
          anthropic_content: message.anthropic_content.map((block) => {
            if (block.type === 'text' && typeof block.text === 'string')
              return { ...block, text: transform(block.text) };
            if (block.type === 'tool_use')
              return {
                ...block,
                input: JSON.parse(transform(JSON.stringify(block.input))),
              };
            // Signed thinking/redacted-thinking blocks must remain byte-identical.
            return block;
          }),
        }
      : {}),
  }));
}

export function sanitizeToolHistory(value: unknown): ChatMessage[] {
  return transformToolHistory(value, redactCredentialSecrets);
}

export function expandStoredMessage(message: {
  role: string;
  content: ChatMessage['content'];
  session_id?: string;
  tool_history_json?: string | null;
  dynamic_context?: string | null;
}): ChatMessage[] {
  const finalMessage: ChatMessage = {
    role: message.role as ChatMessage['role'],
    content: message.content,
  };
  if (message.role === 'user' && message.dynamic_context)
    return [{ role: 'user', content: message.dynamic_context }, finalMessage];
  if (message.role !== 'assistant' || !message.tool_history_json)
    return [finalMessage];
  const history = validateToolHistory(JSON.parse(message.tool_history_json));
  const replay = history.map((entry) =>
    toolResultForHistory(entry, message.session_id || 'session'),
  );
  // A reply written together with the turn's last tool calls, as with a
  // reaction, is in the replay already; repeating it would say it twice.
  const lastCall = [...replay]
    .reverse()
    .find((entry) => entry.role === 'assistant');
  if (
    typeof message.content === 'string' &&
    message.content.trim() &&
    typeof lastCall?.content === 'string' &&
    lastCall.content.trim() === message.content.trim()
  ) {
    return replay;
  }
  return [...replay, finalMessage];
}
