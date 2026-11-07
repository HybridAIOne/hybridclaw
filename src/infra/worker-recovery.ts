/**
 * Failed worker IPC can still have durable tool outcomes in the workspace.
 * This reader preserves authoritative replies. Recovery after interruption
 * returns evidence only, never success, approvals or queued side effects;
 * it never starts a replacement worker or repeats a call.
 */
import { readTurnRecovery } from '../../container/shared/turn-checkpoint.js';
import { CONTAINER_MAX_OUTPUT_SIZE } from '../config/config.js';
import { redactCredentialSecrets } from '../security/redact.js';
import type { ContainerOutput } from '../types/container.js';

export function recoverWorkerOutput(
  output: ContainerOutput,
  workspacePath: string,
  sessionId: string,
  turnId: string | undefined,
  interrupted = false,
): ContainerOutput {
  if (output.status !== 'error' && !interrupted && !output.recovery)
    return output;
  // An authoritative reply can retain its authority. Interrupted/recovered
  // replies are evidence only, even if a partial IPC reply included controls.
  if (
    !interrupted &&
    !output.recovery &&
    (typeof output.result === 'string' ||
      output.toolHistory?.length ||
      output.toolExecutions?.length ||
      output.pendingApproval ||
      output.sideEffects)
  )
    return output;
  const {
    pendingApproval: _approval,
    sideEffects: _effects,
    approvalReply: _reply,
    ...rest
  } = output;
  const failure = { ...rest, status: 'error' as const, result: null };
  const recovered = turnId
    ? readTurnRecovery(
        workspacePath,
        sessionId,
        turnId,
        CONTAINER_MAX_OUTPUT_SIZE,
      )
    : { kind: 'refused' as const, reason: 'missing' as const };
  if (recovered.kind === 'refused')
    return {
      ...failure,
      recovery: { kind: 'refused', turnId },
      error: `${output.error || 'Worker stopped.'}\nWorker recovery refused (${recovered.reason}). Side effects are unknown; verify external state before retrying. Automatic replay refused.`,
    };
  if (
    !interrupted &&
    !output.recovery &&
    !recovered.evidence.toolHistory.length
  )
    return output;
  return {
    ...failure,
    ...recovered.evidence,
    error: `${output.error || 'Worker stopped.'}\n${recovered.evidence.error}`,
  };
}

/** Exceptions after dispatch have the same uncertainty as lost IPC replies. */
export function recoverWorkerFailure(
  error: unknown,
  workspacePath: string,
  sessionId: string,
  turnId: string | undefined,
): ContainerOutput {
  const output = recoverWorkerOutput(
    {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: error instanceof Error ? error.message : String(error),
    },
    workspacePath,
    sessionId,
    turnId,
    true,
  );
  output.error = redactCredentialSecrets(output.error || 'Worker stopped.');
  return output;
}
