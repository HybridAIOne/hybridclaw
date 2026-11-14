/**
 * Structured tool-call validation — decides whether a model response's calls
 * can reach approval and execution at all. Unfinished batches run nothing; the
 * model gets the reason as tool results and may correct it. NOT argument
 * validation per tool (the tool handlers do that) and not a permission check.
 */
import { isCompleteToolCallFinish } from './model-response-completion.js';
import type { ToolCall, ToolExecution } from './types.js';

function describeToolName(toolCall: ToolCall): string {
  const name = String(toolCall.function?.name || '').trim();
  return name || '(unknown tool)';
}

export function validateToolCallBatch(
  toolCalls: ToolCall[],
  finishReason: string | null | undefined,
): string | null {
  if (toolCalls.length && !isCompleteToolCallFinish(finishReason))
    return 'Model response did not complete its tool-call batch.';
  for (const toolCall of toolCalls) {
    const toolName = describeToolName(toolCall);
    const argsJson = String(toolCall.function?.arguments || '').trim();
    if (!argsJson) {
      return `Model emitted invalid tool arguments for \`${toolName}\`: expected a JSON object but received an empty string.`;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `Model emitted malformed tool arguments for \`${toolName}\`: ${detail}.`;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `Model emitted invalid tool arguments for \`${toolName}\`: expected a JSON object.`;
    }
  }

  return null;
}

/** Tool result for every call in a batch that failed validation. */
export function invalidToolCallCorrection(
  error: string,
  finishReason: string | null | undefined,
): string | null {
  if (!isCompleteToolCallFinish(finishReason) && finishReason !== 'length')
    return null;
  const cutOff =
    finishReason === 'length'
      ? 'Your response reached the output-token limit, so the tool-call batch may be incomplete. '
      : '';
  return `Error: ${cutOff}${error} Nothing from that response ran. Send the call again with one complete JSON object as its arguments; split large file contents into several smaller write or edit calls.`;
}

/** Rejected calls keep their linkage without claiming any action started. */
export function rejectedToolExecution(
  call: ToolCall,
  result: string,
): ToolExecution {
  return {
    name: call.function.name,
    arguments: call.function.arguments,
    result,
    toolCallId: call.id,
    durationMs: 0,
    isError: true,
    blocked: true,
    blockedReason: 'Invalid tool call batch.',
  };
}

/**
 * Copy of rejected calls that is safe to replay: providers may refuse history
 * whose arguments are not a JSON object, so those become `{}`.
 */
export function withReplaySafeArguments(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.map((call) => {
    try {
      const parsed = JSON.parse(call.function.arguments) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return call;
      }
    } catch {}
    return { ...call, function: { ...call.function, arguments: '{}' } };
  });
}
