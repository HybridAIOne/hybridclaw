/**
 * Portable tool exchanges preserve call/result pairing across worker lifetimes.
 * Unlike audit events, these are replayable model messages; system/user roles
 * are never accepted here. Full results remain in the session transcript.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type VisualAttachmentMessage,
  validateVisualAttachments,
} from './visual-snapshots.ts';

/** Full results restore from derived files; bounded replay remains bounded. */
export interface FileBackedToolResults {
  spilledToolCallIds?: string[];
}

/** Digest binds one saved outcome; a provider call ID alone is not identity. */
export interface FileBackedToolResult {
  resultDigest?: string;
}

export interface HistoryMessage
  extends VisualAttachmentMessage,
    FileBackedToolResult {
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

export function toolResultDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function isToolResultDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function toolResultFilePath(
  sessionId: string,
  toolCallId: string | undefined,
  digest: string,
): string {
  if (!isToolResultDigest(digest))
    throw new Error('Invalid tool result digest.');
  // Bound the readable label by the digest width; the digest identifies bytes.
  return `${TOOL_RESULTS_DIR}/${safeName(sessionId, 'session')}/${safeName(toolCallId, 'call').slice(0, digest.length)}.${digest}.txt`;
}

/** IPC references identify full evidence; model excerpts are managed separately. */
export function toolResultForTransport<
  T extends { role: string; content: unknown; tool_call_id?: string },
>(message: T, resultPath?: string): T {
  if (message.role !== 'tool' || !resultPath) return message;
  return {
    ...message,
    content: `[Full tool result saved to ${resultPath}.]`,
  } as T;
}

export function validateToolHistory(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value)) throw new Error('Tool history must be an array.');
  const messages: HistoryMessage[] = [];
  const pending = new Set();
  for (const message of value as HistoryMessage[]) {
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
        tool_calls: message.tool_calls.map((call) => ({
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
            const nativeIds = new Set();
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
                  (call) => call.id === block.id,
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
          next[key] = message[key] as never;
        }
      }
      messages.push(next);
    } else if (
      message.role === 'tool' &&
      typeof message.content === 'string' &&
      pending.delete(message.tool_call_id)
    ) {
      if (
        message.resultDigest !== undefined &&
        !isToolResultDigest(message.resultDigest)
      )
        throw new Error('Invalid tool result identity.');
      messages.push({
        role: 'tool',
        content: message.content,
        tool_call_id: message.tool_call_id,
        ...(message.resultDigest === undefined
          ? {}
          : { resultDigest: message.resultDigest }),
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
