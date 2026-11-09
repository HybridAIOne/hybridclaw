/**
 * A controller receipt binds preservation intent to one live worker request.
 * Unlike a tool argument it authenticates where the request came from; it
 * grants no approval. Its MAC domain cannot authenticate IPC inputs or steering.
 */
import {
  decodeAuthenticatedInput,
  encodeAuthenticatedInput,
} from './ipc-input-auth.js';

const PURPOSE = 'hybridclaw-file-write-review-v1';

export function encodeFileWriteGuardContext(secret, request, userPrompt) {
  return encodeAuthenticatedInput(
    secret,
    JSON.stringify({
      sessionId: request.sessionId,
      requestId: request.requestId,
      fileWriteGuardSessionId:
        request.fileWriteGuardSessionId ?? request.sessionId,
      fileWriteGuardUserPrompt: userPrompt,
    }),
    PURPOSE,
  );
}

export function decodeFileWriteGuardContext(secret, raw, request) {
  if (typeof raw !== 'string' || !request.requestId) return null;
  const decoded = decodeAuthenticatedInput(secret, raw, PURPOSE);
  if (decoded.status !== 'ok') return null;
  let body;
  try {
    body = JSON.parse(decoded.body);
  } catch {
    return null;
  }
  if (
    !body ||
    typeof body !== 'object' ||
    body.sessionId !== request.sessionId ||
    body.requestId !== request.requestId ||
    body.fileWriteGuardSessionId !==
      (request.fileWriteGuardSessionId ?? request.sessionId) ||
    typeof body.fileWriteGuardUserPrompt !== 'string'
  )
    return null;
  return {
    fileWriteGuardSessionId: body.fileWriteGuardSessionId,
    fileWriteGuardUserPrompt: body.fileWriteGuardUserPrompt,
  };
}
