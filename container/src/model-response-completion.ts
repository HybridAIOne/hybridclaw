/**
 * Parsed provider replies retain identity and completion state before validation.
 * Missing IDs are filled once; declared IDs and explicit failure reasons stay.
 * Unlike batch validation, this never authorizes or retries an action. Incomplete
 * framing retains available usage but cannot become a final answer or action.
 */
import { randomUUID } from 'node:crypto';
import type { normalizeToolCalls } from './providers/tool-call-normalizer.js';
import type { ChatCompletionResponse } from './types.js';

export function isCompleteToolCallFinish(
  reason: string | null | undefined,
): boolean {
  return reason === 'stop' || reason === 'tool_calls';
}

export function finalizeParsedToolCalls(
  normalized: ReturnType<typeof normalizeToolCalls>,
  reason: string | null | undefined,
) {
  const toolCalls = normalized.toolCalls.map((call) =>
    call.id ? call : { ...call, id: randomUUID() },
  );
  return {
    ...normalized,
    toolCalls,
    finishReason:
      toolCalls.length && (!reason || isCompleteToolCallFinish(reason))
        ? 'tool_calls'
        : reason || 'stop',
  };
}

export const INCOMPLETE_RESPONSE = 'incomplete';

export class IncompleteModelResponseError extends Error {
  readonly usage: ChatCompletionResponse['usage'];

  constructor(response: ChatCompletionResponse) {
    super(
      'The model stream ended before its completion marker. No tool calls from the incomplete response ran.',
    );
    this.name = 'IncompleteModelResponseError';
    this.usage = response.usage;
  }
}

export function requireCompleteModelResponse(
  response: ChatCompletionResponse,
): void {
  if (
    response.choices.some(
      (choice) => choice.finish_reason === INCOMPLETE_RESPONSE,
    )
  )
    throw new IncompleteModelResponseError(response);
}

export function getModelCompletionError(params: {
  finishReason: string | null | undefined;
  isLocal: boolean | undefined;
  hasToolCalls: boolean;
  visibleText: string | null | undefined;
}): string | null {
  if (params.isLocal && !params.hasToolCalls) {
    if (params.finishReason === 'length')
      return 'The local model reached its output-token limit before completing its response. Try a shorter prompt or a model with a larger output budget.';
    if (!params.visibleText?.trim())
      return 'The local model returned no final answer or tool call. Reasoning alone does not confirm task completion.';
  }
  return null;
}
