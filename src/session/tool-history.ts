/**
 * Stored tool exchanges belong to their final assistant message and expand as
 * one unit for replay and compaction. This is conversation storage, not the
 * audit trail; only validated tool exchanges may introduce tool-role messages.
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
}): ChatMessage[] {
  const finalMessage: ChatMessage = {
    role: message.role as ChatMessage['role'],
    content: message.content,
  };
  if (message.role !== 'assistant' || !message.tool_history_json)
    return [finalMessage];
  const history = validateToolHistory(JSON.parse(message.tool_history_json));
  return [
    ...history.map((entry) =>
      toolResultForHistory(entry, message.session_id || 'session'),
    ),
    finalMessage,
  ];
}
