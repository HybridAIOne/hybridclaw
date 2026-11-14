/**
 * Budget notes append to this request's context without rewriting its past.
 * Expiry preserves completed evidence and reported usage; unlike the gateway,
 * this checkpoint does not own cancellation or grant permission to run tools.
 */
import type { ExecutionDeadline } from '@hybridclaw/contracts/agent-io';
import {
  ExecutionDeadlineError,
  remainingExecutionMs,
} from '@hybridclaw/shared/execution-deadline';
import {
  createTokenUsageStats,
  finalizeTokenUsage,
} from '@hybridclaw/shared/token-usage';
import { statusOutputPresentation } from './chat-segments.js';
import { emitRuntimeEvent } from './extensions.js';
import type { ChatMessage, ContainerOutput } from './types.js';

export function expiredExecutionBudget(
  value: number | undefined,
): ContainerOutput | null {
  return remainingExecutionMs(value) === 0
    ? {
        status: 'error',
        result: null,
        toolsUsed: [],
        toolExecutions: [],
        error: new ExecutionDeadlineError().message,
        tokenUsage: createTokenUsageStats(),
        outputPresentation: statusOutputPresentation(true),
      }
    : null;
}

export async function checkpointExecutionBudget(
  params: ExecutionDeadline & {
    state: Pick<
      ContainerOutput,
      | 'toolsUsed'
      | 'toolExecutions'
      | 'artifacts'
      | 'tokenUsage'
      | 'effectiveUserPrompt'
    >;
    collectArtifacts: () => void;
  },
): Promise<ContainerOutput | null> {
  const expired = expiredExecutionBudget(params.executionDeadlineAtMs);
  if (expired) {
    params.collectArtifacts();
    const failed: ContainerOutput = {
      ...expired,
      ...params.state,
      toolsUsed: [...new Set(params.state.toolsUsed)],
      tokenUsage: params.state.tokenUsage
        ? finalizeTokenUsage(params.state.tokenUsage)
        : expired.tokenUsage,
    };
    await emitRuntimeEvent({
      event: 'turn_end',
      status: failed.status,
      toolsUsed: failed.toolsUsed,
    });
    return failed;
  }

  return null;
}

export function appendExecutionBudget(
  history: ChatMessage[],
  deadlineAtMs: number | undefined,
): void {
  const remaining = remainingExecutionMs(deadlineAtMs);
  if (remaining !== undefined)
    history.push({
      role: 'user',
      content: `[Runtime execution budget: at most ${Math.ceil(remaining / 1000)} seconds remain for this request.]`,
    });
}
