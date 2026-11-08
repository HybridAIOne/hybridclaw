/**
 * Only a live executor request can authenticate a worker's preservation intent.
 * This registry owns per-request verification, unlike chat cancellation or
 * durable delegation state. Closing a call revokes its receipts immediately.
 */
import {
  decodeFileWriteGuardContext,
  type FileWriteGuardContext,
  type FileWriteGuardRequest,
} from '../../container/shared/file-write-guard.js';
import type { ContainerOutput } from '../types/container.js';

const active = new Map<
  string,
  (proof: unknown) => FileWriteGuardContext | null
>();

export function resolveFileWriteReviewContext(
  sessionId: string,
  proof: unknown,
): FileWriteGuardContext | null {
  return active.get(sessionId)?.(proof) ?? null;
}

export function beginFileWriteReviewContext(
  request: FileWriteGuardRequest,
  secret: string,
) {
  if (active.has(request.sessionId))
    throw new Error('Worker request context is already active.');
  const snapshot = {
    sessionId: request.sessionId,
    requestId: request.requestId,
    fileWriteGuardSessionId: request.fileWriteGuardSessionId,
  };
  const verify = (proof: unknown) =>
    decodeFileWriteGuardContext(secret, proof, snapshot);
  active.set(request.sessionId, verify);
  return {
    finish(output: ContainerOutput): ContainerOutput {
      const context =
        active.get(request.sessionId) === verify
          ? verify(output.fileWriteGuardProof)
          : null;
      delete output.fileWriteGuardProof;
      delete output.fileWriteGuardSessionId;
      delete output.fileWriteGuardUserPrompt;
      if (!output.sideEffects?.delegations?.length) return output;
      if (context) return { ...output, ...context };
      return {
        ...output,
        status: 'error',
        result: null,
        error: [
          output.error,
          'Delegation request context could not be authenticated; no background child was started.',
        ]
          .filter(Boolean)
          .join('\n'),
        sideEffects: { ...output.sideEffects, delegations: undefined },
      };
    },
    close() {
      if (active.get(request.sessionId) === verify)
        active.delete(request.sessionId);
    },
  };
}
