/**
 * Portable tool exchanges preserve call/result pairing across worker lifetimes.
 * Unlike audit events, these are replayable model messages; system/user roles
 * are never accepted here. Full results remain in the session transcript.
 */
import { isDeepStrictEqual } from 'node:util';
import type { VisualAttachmentMessage } from './visual-snapshots.js';
import { validateVisualAttachments } from './visual-snapshots.js';

interface HistoryMessage extends VisualAttachmentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  is_error?: boolean;
  anthropic_content?: Array<{ type: string; [key: string]: unknown }>;
  openai_response_items?: Array<Record<string, unknown>>;
}
type HistoryToolCall = NonNullable<HistoryMessage['tool_calls']>[number];

export const TOOL_RESULTS_DIR: string = '.tool-results';

function safeName(value: unknown, fallback: string): string {
  return (
    String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '_') || fallback
  );
}

export function sessionTranscriptFilename(sessionId: string): string {
  return `${safeName(sessionId, 'session')}.jsonl`;
}

export function toolResultFilePath(
  sessionId: string,
  toolCallId: string | undefined,
): string {
  return `${TOOL_RESULTS_DIR}/${safeName(sessionId, 'session')}/${safeName(toolCallId, 'call')}.txt`;
}

/** File references bound IPC only; model and replay messages retain full text. */
export function toolResultForTransport<
  T extends { role: string; content: unknown; tool_call_id?: string },
>(message: T, resultPath?: string): T {
  if (message.role !== 'tool' || !resultPath) return message;
  return {
    ...message,
    content: `[Full tool result saved to ${resultPath}.]`,
  };
}

export function validateToolHistory(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value)) throw new Error('Tool history must be an array.');
  const messages: HistoryMessage[] = [];
  const pending = new Set<string>();
  for (const message of value) {
    if (
      !message ||
      typeof message !== 'object' ||
      !(message.content === null || typeof message.content === 'string')
    ) {
      throw new Error('Invalid tool history message.');
    }
    if (message.role === 'assistant') {
      if (
        pending.size ||
        !Array.isArray(message.tool_calls) ||
        !message.tool_calls.length
      ) {
        throw new Error('Tool history contains an incomplete exchange.');
      }
      for (const call of message.tool_calls) {
        if (
          !call ||
          typeof call.id !== 'string' ||
          !call.id ||
          pending.has(call.id) ||
          call.type !== 'function' ||
          typeof call.function?.name !== 'string' ||
          !call.function.name ||
          typeof call.function.arguments !== 'string'
        ) {
          throw new Error('Invalid historical tool call.');
        }
        pending.add(call.id);
      }
      const next: HistoryMessage = {
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls.map((call: HistoryToolCall) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        })),
      };
      for (const key of [
        'anthropic_content',
        'openai_response_items',
      ] as const) {
        if (message[key] !== undefined) {
          if (
            !Array.isArray(message[key]) ||
            message[key].some(
              (item) =>
                !item || typeof item !== 'object' || Array.isArray(item),
            )
          ) {
            throw new Error('Invalid provider tool history metadata.');
          }
          if (
            key === 'openai_response_items' &&
            message[key].some((item) => item.type !== 'reasoning')
          ) {
            throw new Error(
              'Only reasoning metadata may accompany historical OpenAI tool calls.',
            );
          }
          if (key === 'anthropic_content') {
            const nativeIds = new Set<string>();
            for (const block of message[key]) {
              if (
                !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(
                  block.type,
                )
              ) {
                throw new Error(
                  'Unexpected historical Anthropic content block.',
                );
              }
              if (block.type === 'tool_use') {
                const call = message.tool_calls.find(
                  (call: HistoryToolCall) => call.id === block.id,
                );
                if (
                  !call ||
                  nativeIds.has(block.id) ||
                  call.function.name !== block.name ||
                  !isDeepStrictEqual(
                    JSON.parse(call.function.arguments),
                    block.input,
                  )
                ) {
                  throw new Error(
                    'Historical Anthropic tool metadata does not match its calls.',
                  );
                }
                nativeIds.add(block.id);
              }
            }
            if (nativeIds.size !== pending.size)
              throw new Error('Missing historical Anthropic tool metadata.');
          }
          next[key] = message[key];
        }
      }
      messages.push(next);
    } else if (
      message.role === 'tool' &&
      typeof message.content === 'string' &&
      pending.delete(message.tool_call_id)
    ) {
      messages.push({
        role: 'tool',
        content: message.content,
        tool_call_id: message.tool_call_id,
        ...(message.is_error === true ? { is_error: true } : {}),
        ...(message.visualAttachments !== undefined
          ? {
              visualAttachments: validateVisualAttachments(
                message.visualAttachments,
              ),
            }
          : {}),
      });
    } else {
      throw new Error('Tool history contains an unexpected role or result.');
    }
  }
  if (pending.size) throw new Error('Tool history contains missing results.');
  return messages;
}
