/**
 * Agent end of mid-turn steering: notes the user sends while a turn runs.
 *
 * A note reaches the model at its next step: after the tool call that is
 * running (calls of the same batch not yet started are answered "not run" so
 * the model can re-plan), or, where the turn would end, as a user message
 * after which the loop calls the model again. Where the turn would end, the
 * inbox is closed first and reopened only when notes were waiting, so a note
 * the gateway delivered is never left behind by a turn that finished.
 *
 * NOT the gateway's half (src/infra/steer-inbox.ts) and NOT the on-disk
 * format (shared/steer-inbox.js). Notes of a turn that fails or is stopped
 * are dropped with it, as its other work is.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  closedSteerInboxDirName,
  type SteerNote,
  steerInboxDirName,
} from '../shared/steer-inbox.js';
import { decodeSteerNoteFile } from './ipc.js';
import { IPC_DIR } from './runtime-paths.js';
import type { ChatMessage, ToolCall } from './types.js';

interface ActiveSteerInbox {
  requestId: string;
  seen: Set<string>;
  shownIds: string[];
}

let active: ActiveSteerInbox | null = null;

const NOT_RUN_RESULT =
  'Not run: the user sent a message before this call started. Call it again if it is still wanted.';

/**
 * Opens the inbox of a request; a request without an id has none. The agent
 * makes it, not the gateway, so an agent that predates steering never has
 * one and the gateway refuses every note for it.
 */
export function beginSteerInbox(requestId: string | undefined): void {
  active = requestId ? { requestId, seen: new Set(), shownIds: [] } : null;
  if (!active) return;
  try {
    fs.mkdirSync(inboxPath(active, false));
  } catch (error) {
    // The gateway made it already to offer this request the turn's notes.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.error('[steer] could not open the inbox:', error);
    }
  }
}

function inboxPath(inbox: ActiveSteerInbox, closed: boolean): string {
  return path.join(
    IPC_DIR,
    closed
      ? closedSteerInboxDirName(inbox.requestId)
      : steerInboxDirName(inbox.requestId),
  );
}

/** Reads and removes every note in `dir`, oldest first. */
function drain(inbox: ActiveSteerInbox, dir: string): SteerNote[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const notes: SteerNote[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    try {
      fs.rmSync(filePath, { force: true, recursive: true });
    } catch {
      // A note that cannot be removed is still read only once (`seen`).
    }
    const note = decodeSteerNoteFile(inbox.requestId, raw);
    if (!note) {
      console.error('[steer] dropped a note that failed verification');
      continue;
    }
    if (inbox.seen.has(note.id)) continue;
    inbox.seen.add(note.id);
    notes.push(note);
  }
  return notes;
}

/** Closes the inbox, so the gateway refuses notes from here on, and drains it. */
function close(inbox: ActiveSteerInbox): SteerNote[] {
  const closed = inboxPath(inbox, true);
  try {
    fs.renameSync(inboxPath(inbox, false), closed);
  } catch {
    // No inbox: none was made for this request, or it is closed already.
    return [];
  }
  return drain(inbox, closed);
}

/**
 * Closes the inbox and takes what it held. With notes, it is reopened: the
 * turn goes on and can take more. Without, it stays closed and the caller may
 * end the turn.
 */
function takeOrClose(inbox: ActiveSteerInbox): SteerNote[] {
  const notes = close(inbox);
  if (notes.length > 0) {
    try {
      fs.renameSync(inboxPath(inbox, true), inboxPath(inbox, false));
    } catch (error) {
      console.error('[steer] could not reopen the inbox:', error);
    }
  }
  return notes;
}

function steerUserMessage(notes: SteerNote[]): ChatMessage {
  const header =
    notes.length === 1
      ? '[The user sent this while you were working:]'
      : '[The user sent these while you were working:]';
  return {
    role: 'user',
    content: [
      header,
      ...notes.map((note) => note.content.trim()),
      '[If it asks you to stop, or says what you are doing is unwanted, stop now: make no more tool calls for that task, reply briefly and hand control back. If it is unclear, ask. Otherwise take it into account and continue.]',
    ].join('\n\n'),
  };
}

function show(
  inbox: ActiveSteerInbox,
  notes: SteerNote[],
  history: ChatMessage[],
): void {
  history.push(steerUserMessage(notes));
  inbox.shownIds.push(...notes.map((note) => note.id));
  console.error(`[steer] showed ${notes.length} note(s) to the model`);
}

/**
 * Between tool calls: shows waiting notes to the model. `unrunCalls` (calls of
 * the current batch not started yet) are answered "not run", so the model
 * decides afresh whether to make them. With `closeIfEmpty`, the inbox stays
 * closed when nothing was waiting: the caller is about to end the turn.
 */
export function steerAfterToolCalls(params: {
  history: ChatMessage[];
  unrunCalls: ToolCall[];
  recordResult: (message: ChatMessage) => ChatMessage;
  closeIfEmpty?: boolean;
}): boolean {
  const inbox = active;
  if (!inbox) return false;
  const notes = params.closeIfEmpty
    ? takeOrClose(inbox)
    : drain(inbox, inboxPath(inbox, false));
  if (notes.length === 0) return false;
  for (const call of params.unrunCalls) {
    params.history.push(
      params.recordResult({
        role: 'tool',
        tool_call_id: call.id,
        content: NOT_RUN_RESULT,
      }),
    );
  }
  show(inbox, notes, params.history);
  return true;
}

/**
 * Where the turn would end: true when notes were waiting and are now in
 * `history`, so the loop must call the model again instead of finishing.
 */
export function steerBeforeFinishing(history: ChatMessage[]): boolean {
  const inbox = active;
  if (!inbox) return false;
  const notes = takeOrClose(inbox);
  if (notes.length === 0) return false;
  show(inbox, notes, history);
  return true;
}

/**
 * Ends the request's inbox: closes it so the gateway refuses later notes, and
 * returns the ids of the notes the model was shown, in order. Notes still
 * waiting belong to a turn that ended without another model step (an error,
 * a stop); they are dropped.
 */
export function finishSteerInbox(): string[] {
  const inbox = active;
  active = null;
  if (!inbox) return [];
  const leftover = close(inbox);
  if (leftover.length > 0) {
    console.error(
      `[steer] dropped ${leftover.length} note(s): the turn ended first`,
    );
  }
  try {
    fs.rmSync(inboxPath(inbox, false), { recursive: true, force: true });
    fs.rmSync(inboxPath(inbox, true), { recursive: true, force: true });
  } catch {
    // The gateway removes them when the request ends.
  }
  return inbox.shownIds;
}

/** Joins the reply written before a note and the one written after it. */
export function joinSteeredReply(
  before: string,
  after: string | null,
): string | null {
  const head = before.trim();
  if (!head) return after;
  const tail = after?.trim();
  return tail ? `${head}\n\n${tail}` : head;
}
