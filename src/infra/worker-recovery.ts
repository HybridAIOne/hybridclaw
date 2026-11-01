/**
 * Failed worker IPC can still have durable tool outcomes in the workspace.
 * This reader preserves authoritative replies. Recovery after interruption
 * returns evidence only, never success, approvals or queued side effects;
 * it never starts a replacement worker or repeats a call.
 */
import {
  checkpointOutput,
  readTurnCheckpoint,
} from '../../container/shared/turn-checkpoint.js';
import { CONTAINER_MAX_OUTPUT_SIZE } from '../config/config.js';
import type { ContainerOutput } from '../types/container.js';

export function recoverWorkerOutput(
  output: ContainerOutput,
  workspacePath: string,
  sessionId: string,
  turnId: string | undefined,
  interrupted = false,
): ContainerOutput {
  if (output.status !== 'error' || !turnId) return output;
  if (
    !interrupted &&
    (output.toolHistory?.length ||
      output.toolExecutions?.length ||
      output.pendingApproval ||
      output.sideEffects)
  )
    return output;
  const failure = interrupted
    ? { ...output, pendingApproval: undefined, sideEffects: undefined }
    : output;
  try {
    const saved = readTurnCheckpoint(
      workspacePath,
      sessionId,
      CONTAINER_MAX_OUTPUT_SIZE,
    );
    if (!saved || saved.turnId !== turnId) return failure;
    if (!interrupted && !saved.messages.length) return output;
    const recovered = checkpointOutput(saved);
    return {
      ...failure,
      ...recovered,
      pendingApproval: undefined,
      sideEffects: undefined,
      error: `${output.error || 'Worker stopped.'}\n${recovered.error}`,
    };
  } catch {
    return {
      ...failure,
      error:
        'Worker recovery checkpoint is unreadable. Side effects are unknown; verify external state before retrying. Automatic replay refused.',
    };
  }
}
