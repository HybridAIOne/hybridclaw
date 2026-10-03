/**
 * Gateway end of mid-turn steering: one inbox per gateway turn, bound to the
 * agent request that is running for it.
 *
 * `deliver` says yes only when the note is in the open inbox of a running
 * request, which the agent made and drains before it may end the turn
 * (container/src/steer-inbox.ts), so a yes is never a note the turn could miss. Once the
 * agent has closed the inbox, or the request has returned, it says no and the
 * caller sends the note as its own turn.
 *
 * A turn that runs a second request (model routing escalates) starts again
 * from the turn's messages, so each request is offered every note of the turn.
 * NOT the HTTP route (`gateway/chat-steer-route.ts`) and NOT the on-disk format
 * (`container/shared/steer-inbox.js`).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  closedSteerInboxDirName,
  encodeSteerNote,
  type SteerNote,
  steerInboxDirName,
  steerNoteFileName,
} from '../../container/shared/steer-inbox.js';
import { logger } from '../logger.js';

interface BoundRequest {
  ipcDir: string;
  requestId: string;
  authSecret: string;
}

export class SteerInbox {
  private request: BoundRequest | null = null;
  private readonly delivered: SteerNote[] = [];

  /**
   * Binds the inbox to the request about to start in `ipcDir`. The agent makes
   * the inbox directory when it takes the request, so an agent without
   * steering never takes a note. Notes of an earlier request of this turn are
   * written ahead: only an agent that took them can have caused them.
   */
  open(request: BoundRequest): void {
    this.close();
    this.request = request;
    if (this.delivered.length === 0) return;
    try {
      fs.mkdirSync(
        path.join(request.ipcDir, steerInboxDirName(request.requestId)),
      );
    } catch (error) {
      logger.warn(
        { error, requestId: request.requestId },
        'Could not offer the turn’s steering notes to its next request',
      );
      return;
    }
    this.delivered.forEach((note, index) => {
      this.write(request, index, note);
    });
  }

  /** Unbinds the inbox; notes from here on are refused. */
  close(): void {
    const request = this.request;
    this.request = null;
    if (!request) return;
    for (const name of [
      steerInboxDirName(request.requestId),
      closedSteerInboxDirName(request.requestId),
    ]) {
      fs.rmSync(path.join(request.ipcDir, name), {
        recursive: true,
        force: true,
      });
    }
  }

  /** True when the running request will show `content` to the model. */
  deliver(content: string): boolean {
    const request = this.request;
    if (!request) return false;
    const note: SteerNote = { id: randomUUID(), content };
    if (!this.write(request, this.delivered.length, note)) return false;
    this.delivered.push(note);
    return true;
  }

  /** The notes behind the ids the agent reports it showed, in its order. */
  shownNotes(ids: readonly string[] | undefined): string[] {
    const byId = new Map(this.delivered.map((note) => [note.id, note.content]));
    // Ids come from the agent; only notes this inbox delivered count.
    return [...new Set(ids ?? [])].flatMap((id) => byId.get(id) ?? []);
  }

  private write(
    request: BoundRequest,
    sequence: number,
    note: SteerNote,
  ): boolean {
    const staging = path.join(
      request.ipcDir,
      `${steerInboxDirName(request.requestId)}.${note.id}.tmp`,
    );
    try {
      fs.writeFileSync(
        staging,
        encodeSteerNote(request.authSecret, {
          ...note,
          requestId: request.requestId,
        }),
        { mode: 0o600 },
      );
      // Fails once the agent has closed the inbox: the turn is finishing.
      fs.renameSync(
        staging,
        path.join(
          request.ipcDir,
          steerInboxDirName(request.requestId),
          steerNoteFileName(sequence, note.id),
        ),
      );
      return true;
    } catch {
      fs.rmSync(staging, { force: true });
      return false;
    }
  }
}
