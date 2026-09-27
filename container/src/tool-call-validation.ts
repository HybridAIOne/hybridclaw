/**
 * Structured tool-call validation — decides whether a model response's calls
 * can reach approval and execution at all. A rejected batch runs nothing; the
 * model gets the reason as tool results and may correct it. NOT argument
 * validation per tool (the tool handlers do that) and not a permission check.
 */
import type { ToolCall } from './types.js';

function describeToolName(toolCall: ToolCall): string {
  const name = String(toolCall.function?.name || '').trim();
  return name || '(unknown tool)';
}

export function validateStructuredToolCalls(
  toolCalls: ToolCall[],
): string | null {
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
  finishReason?: string | null,
): string {
  const cutOff =
    finishReason === 'length'
      ? 'Your response reached the output-token limit, so the tool arguments were cut off. '
      : '';
  return `Error: ${cutOff}${error} Nothing from that response ran. Send the call again with one complete JSON object as its arguments; split large file contents into several smaller write or edit calls.`;
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
