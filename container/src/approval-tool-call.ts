/**
 * Display descriptions are separated once from executable shell calls before
 * approval, hooks, storage, audit, or execution. The provider's original calls
 * remain untouched in conversation history; descriptions never grant consent.
 */
import { isRecord } from '#shared/primitive-values.js';
import { normalizeText } from './text-normalization.js';
import type { ToolCall } from './types.js';

// 600 characters (Codex implementation choice, 2026-10-29): enough for two
// concrete sentences; longer explanations belong in the on-demand review.
export const MAX_BASH_DESCRIPTION_CHARS = 600;

export function prepareApprovalToolCalls(calls: ToolCall[]): {
  calls: ToolCall[];
  descriptions: ReadonlyMap<ToolCall, string>;
} {
  const descriptions = new Map<ToolCall, string>();
  const prepared = calls.map((call) => {
    if (call.function.name !== 'bash') return call;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      // Structured-call validation rejects malformed JSON before it can run.
      return call;
    }
    if (!isRecord(args) || !('description' in args)) return call;
    const { description, ...executionArgs } = args;
    const text =
      typeof description === 'string' ? normalizeText(description) : '';
    const preparedCall = {
      ...call,
      function: { ...call.function, arguments: JSON.stringify(executionArgs) },
    };
    if (text && text.length <= MAX_BASH_DESCRIPTION_CHARS) {
      descriptions.set(preparedCall, text);
    }
    return preparedCall;
  });
  return { calls: prepared, descriptions };
}
