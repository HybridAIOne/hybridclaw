/**
 * An error turn starts only the delegations the gateway received and enqueued,
 * as its `delegationAcknowledgement` records. A stop drops them even when the
 * agent's shutdown output carries them (the user's kill switch); a timeout,
 * crash, or thrown error never delivered them. `delegate` had already answered
 * "Delegation accepted", so a turn stored without an acknowledgement says that
 * nothing was started. NOT `agent/side-effects.ts`, which starts delegations.
 */
import type { ChatMessage } from '../types/api.js';
import type { ContainerOutput } from '../types/container.js';
import type { ErrorTurnToolRecord } from './gateway-service.js';

export const INTERRUPTED_DELEGATIONS_NOTE =
  'Delegations requested in this turn were not started; no delegate results will arrive.';

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
  return { ...output, sideEffects: undefined };
}

/** The tool histories to store for an error turn that started no delegation. */
export function withDelegationsNotStarted(
  turn: Pick<ContainerOutput, 'toolHistory' | 'toolHistoryForReplay'>,
): Pick<ContainerOutput, 'toolHistory' | 'toolHistoryForReplay'> {
  return {
    toolHistory: markDelegateResultsNotStarted(turn.toolHistory),
    toolHistoryForReplay: markDelegateResultsNotStarted(
      turn.toolHistoryForReplay,
    ),
  };
}

/** The error-placeholder line for a delegating turn that started nothing. */
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
