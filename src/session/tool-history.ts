/**
 * Stored tool exchanges belong to their final assistant message and expand as
 * one unit for replay and compaction. This is conversation storage, not the
 * audit trail; only validated tool exchanges may introduce tool-role messages.
 * Input transforms preserve JSON structure and keep provider copies in sync;
 * signed reasoning metadata is never transformed.
 * A user message expands with the dynamic context it was sent with, so replay
 * reproduces the earlier request byte for byte.
 */
import { validateToolHistory } from '../../container/shared/tool-history.js';
import {
  redactCredentialSecrets,
  redactSecretsDeep,
} from '../security/redact.js';
import type { ChatMessage } from '../types/api.js';

function transformInputStrings(
  value: unknown,
  transform: (text: string) => string,
): unknown {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value))
    return value.map((entry) => transformInputStrings(entry, transform));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      transform(key),
      transformInputStrings(entry, transform),
    ]),
  );
}

export function transformToolHistory(
  value: unknown,
  transform: (text: string) => string,
  transformInput: (input: unknown) => unknown = (input) =>
    transformInputStrings(input, transform),
): ChatMessage[] {
  return validateToolHistory(value).map((message) => {
    const inputs = new Map<unknown, unknown>();
    const toolCalls = message.tool_calls?.map((call) => {
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        // Failed non-native calls may retain malformed arguments for replay.
        return {
          ...call,
          function: {
            ...call.function,
            arguments: transform(call.function.arguments),
          },
        };
      }
      const transformed = transformInput(input);
      inputs.set(call.id, transformed);
      return {
        ...call,
        function: { ...call.function, arguments: JSON.stringify(transformed) },
      };
    });
    return {
      ...message,
      content:
        typeof message.content === 'string'
          ? transform(message.content)
          : message.content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(message.anthropic_content
        ? {
            anthropic_content: message.anthropic_content.map((block) => {
              if (block.type === 'text' && typeof block.text === 'string')
                return { ...block, text: transform(block.text) };
              if (block.type === 'tool_use')
                return {
                  ...block,
                  input: inputs.get(block.id),
                };
              // Signed thinking/redacted-thinking blocks must remain byte-identical.
              return block;
            }),
          }
        : {}),
    };
  });
}

export function sanitizeToolHistory(value: unknown): ChatMessage[] {
  return transformToolHistory(value, redactCredentialSecrets, (input) =>
    redactSecretsDeep(input, redactCredentialSecrets),
  );
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
  const replay = validateToolHistory(JSON.parse(message.tool_history_json));
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
