/**
 * A stop is the user's kill switch: an interrupted turn never starts the
 * delegations it queued, even when the agent's shutdown output carries them.
 * `delegate` had already answered "Delegation accepted", so this module also
 * corrects the stored turn: later turns read that nothing was started.
 * NOT `agent/side-effects.ts`, which starts the delegations of finished turns.
 */
import type { ChatMessage } from '../types/api.js';
import type { ContainerOutput } from '../types/container.js';
import type { ErrorTurnToolRecord } from './gateway-service.js';

export const INTERRUPTED_DELEGATIONS_NOTE =
  'Delegations requested in this turn were not started because the turn was interrupted; no delegate results will arrive.';

function markDelegateResultsNotStarted(
  history: ChatMessage[] | undefined,
): ChatMessage[] | undefined {
  const delegateCallIds = new Set(
    history?.flatMap((message) =>
      (message.tool_calls || [])
        .filter((call) => call.function.name === 'delegate')
        .map((call) => call.id),
    ),
  );
  // Failed calls queued nothing, and their results already say so.
  return history?.map((message) =>
    message.role === 'tool' &&
    !message.is_error &&
    typeof message.content === 'string' &&
    delegateCallIds.has(message.tool_call_id || '')
      ? {
          ...message,
          content: `${message.content}\n\n[${INTERRUPTED_DELEGATIONS_NOTE}]`,
          is_error: true,
        }
      : message,
  );
}

export function dropInterruptedDelegations(
  output: ContainerOutput,
): ContainerOutput {
  return {
    ...output,
    sideEffects: undefined,
    toolHistory: markDelegateResultsNotStarted(output.toolHistory),
    toolHistoryForReplay: markDelegateResultsNotStarted(
      output.toolHistoryForReplay,
    ),
  };
}

/** The error-placeholder line, when the interrupted turn asked to delegate. */
export function interruptedDelegationsNote(
  tools: readonly ErrorTurnToolRecord[],
): string | null {
  return tools.some(
    (tool) =>
      tool.name === 'delegate' &&
      tool.outcome !== 'failed' &&
      tool.outcome !== 'blocked',
  )
    ? INTERRUPTED_DELEGATIONS_NOTE
    : null;
}
