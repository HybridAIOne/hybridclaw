/**
 * Preservation receipts use the controller's effective request after replay.
 * Model-authored delegation fields never supply intent. This cache is reset
 * per authenticated input; it is not durable approval or conflict state.
 */
import { fileWriteReviewContext } from './file-write-conflicts.js';
import { authenticateFileWriteGuardContext } from './ipc.js';
import { steeredUserPrompt } from './steer-inbox.js';

let current:
  | { sessionId: string; requestId?: string; userPrompt: string }
  | undefined;

export function setFileWriteReviewRequest(
  sessionId: string,
  requestId?: string,
  userPrompt = '',
): void {
  current = { sessionId, requestId, userPrompt };
}

export function fileWriteGuardProof(): string | undefined {
  if (!current?.requestId) return undefined;
  const context = fileWriteReviewContext(
    current.sessionId,
    steeredUserPrompt(current.userPrompt),
  );
  if (context.fileWriteGuardUserPrompt === undefined) return undefined;
  return authenticateFileWriteGuardContext(
    { ...current, ...context },
    context.fileWriteGuardUserPrompt,
  );
}
