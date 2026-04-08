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
