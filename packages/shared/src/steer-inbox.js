/**
 * Mid-turn steering inbox, shared by the gateway writer (src/infra/
 * steer-inbox.ts) and the agent reader (container/src/steer-inbox.ts).
 *
 * Each request has one inbox directory in its IPC dir, `steer-<requestId>`,
 * made by the agent when it takes the request (an agent without steering makes
 * none, so it is never sent a note). The gateway delivers a note by
 * renaming a finished file into it; the agent closes the inbox by renaming the
 * directory to `steer-<requestId>.closed` before it ends the turn. That rename
 * is the only ordering point between the two sides: a delivery that lands
 * before it is drained with the inbox, one after it fails, so every note is
 * either seen by the turn or refused to the sender, never both and never
 * neither.
 *
 * Notes are signed with the per-worker IPC secret (ipc-input-auth.js) over a
 * body that names the request and the note, so a note written by the agent's
 * own tools, or copied from another request, is dropped, never shown to the
 * model as the user's words. NOT the follow-up input file: a note never starts
 * a turn.
 */
import {
  decodeAuthenticatedInput,
  encodeAuthenticatedInput,
} from './ipc-input-auth.js';

function safeRequestId(requestId) {
  // The id arrives over IPC; keep the names inside the IPC directory.
  return String(requestId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function steerInboxDirName(requestId) {
  return `steer-${safeRequestId(requestId)}`;
}

export function closedSteerInboxDirName(requestId) {
  return `${steerInboxDirName(requestId)}.closed`;
}

export function isSteerInboxEntryName(name) {
  return /^steer-[a-zA-Z0-9_-]+(\.closed|\.[a-zA-Z0-9_-]+\.tmp)?$/.test(name);
}

/** Names sort in delivery order. */
export function steerNoteFileName(sequence, id) {
  return `${String(sequence).padStart(6, '0')}-${safeRequestId(id)}.json`;
}

export function encodeSteerNote(secret, note) {
  return encodeAuthenticatedInput(
    secret,
    JSON.stringify({
      requestId: note.requestId,
      id: note.id,
      content: note.content,
    }),
  );
}

/** The note in `raw` if it is authentic and for `requestId`, else null. */
export function decodeSteerNote(secret, requestId, raw) {
  const decoded = decodeAuthenticatedInput(secret, raw);
  if (decoded.status !== 'ok') return null;
  let body;
  try {
    body = JSON.parse(decoded.body);
  } catch {
    return null;
  }
  if (
    !body ||
    body.requestId !== requestId ||
    typeof body.id !== 'string' ||
    !body.id ||
    typeof body.content !== 'string' ||
    !body.content.trim()
  ) {
    return null;
  }
  return { id: body.id, content: body.content };
}
