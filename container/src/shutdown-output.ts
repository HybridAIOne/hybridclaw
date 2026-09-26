/**
 * The output a signalled agent writes for its in-flight request. It keeps the
 * tool exchanges that already ran, so the gateway can replay them after an
 * interrupt; the request itself still ends as an error, never as success.
 */
import type { TurnToolHistory } from './turn-tool-history.js';
import type { ContainerOutput } from './types.js';

export function buildInterruptedShutdownOutput(
  reason: NodeJS.Signals,
  sideEffects?: ContainerOutput['sideEffects'],
  turnToolHistory?: TurnToolHistory | null,
): ContainerOutput {
  const output: ContainerOutput = {
    status: 'error',
    result: null,
    toolsUsed: [],
    toolExecutions: [],
    error: `Request interrupted: the agent process received ${reason} before producing a final response.`,
    ...(sideEffects ? { sideEffects } : {}),
  };
  const openCallReason = `the agent process received ${reason} before this call returned; it may not have run, or may have run partially.`;
  const toolHistory = turnToolHistory?.finishInterrupted(openCallReason);
  return toolHistory?.length
    ? {
        ...output,
        toolHistory,
        toolHistoryForReplay: turnToolHistory?.finishInterrupted(
          openCallReason,
          true,
        ),
      }
    : output;
}
