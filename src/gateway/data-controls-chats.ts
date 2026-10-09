/**
 * The phone's chats as the gateway keeps them. A chat is everything stored
 * under the id the phone sends (`main-…` for Hy's main chat, `ios-…` and
 * `android-…` for side chats): `/clear` and `/new` start further session rows
 * under that key, so listing, archiving and deleting work on the key, never on
 * one row. Archive flags and deletion records live in `kv_store` under a fixed
 * scope, which agent resets and session rotation leave alone.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getInFlightExecutorSessionIds } from '../agent/executor.js';
import { DATA_DIR } from '../config/config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { clearCanonicalContext } from '../memory/canonical-sessions.js';
import { deleteArchives } from '../memory/compaction-archive.js';
import { withMemoryDatabase } from '../memory/database.js';
import { getMemoryValue, setMemoryValue } from '../memory/kv.js';
import { scopeWorkspaceDir } from '../scopes/scope-paths.js';
import { deleteGatewayAdminSession } from './gateway-session-deletion.js';
import { deleteWebNotificationSession } from './web-notification-store.js';

const SCOPE = 'data-controls';
const ARCHIVED_KEY = 'archived-chats';
const DELETED_KEY = 'deleted-chats';
// Enough for every phone to see a deletion; older records only matter to a
// phone that has been offline since.
const MAX_DELETIONS = 1000;
const PREVIEW_CHARS = 60;

export interface DataChat {
  id: string;
  title: string;
  agent: string;
  updatedAt: string;
  messageCount: number;
  archived: boolean;
  revision: string;
}

export interface DataDeletion {
  id: string;
  deletedAt: string;
  lastMessageID: number;
}

interface SessionRow {
  id: string;
  chat: string;
  agent: string;
  current: number;
  title: string | null;
  lastActive: string | null;
  messages: number;
  lastMessageId: number | null;
  lastMessageAt: string | null;
  scope: string | null;
}

/** SQLite's `datetime('now')` has no zone; it is UTC. */
export function isoDate(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value);
  const date = new Date(sqlite ? `${value.replace(' ', 'T')}Z` : value);
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
}

function sessionRows(chat?: string): SessionRow[] {
  return withMemoryDatabase(
    (db) =>
      db
        .prepare(
          `SELECT s.id, COALESCE(s.session_key, s.id) AS chat,
                  COALESCE(s.agent_id, 'main') AS agent, s.scope AS scope,
                  s.is_current AS current, s.title, s.last_active AS lastActive,
                  COUNT(m.id) AS messages, MAX(m.id) AS lastMessageId,
                  MAX(m.created_at) AS lastMessageAt
           FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
           WHERE s.channel_id = 'web'
             AND (COALESCE(s.session_key, s.id) GLOB 'main-*'
               OR COALESCE(s.session_key, s.id) GLOB 'ios-*'
               OR COALESCE(s.session_key, s.id) GLOB 'android-*')
             ${chat ? 'AND COALESCE(s.session_key, s.id) = ?' : ''}
           GROUP BY s.id`,
        )
        .all(...(chat ? [chat] : [])) as SessionRow[],
  );
}

function firstUserLine(sessionIds: string[]): string | null {
  const row = withMemoryDatabase(
    (db) =>
      db
        .prepare(
          `SELECT content FROM messages
           WHERE role = 'user' AND session_id IN (${sessionIds.map(() => '?').join(', ')})
           ORDER BY id LIMIT 1`,
        )
        .get(...sessionIds) as { content: string } | undefined,
  );
  const line = row?.content.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > PREVIEW_CHARS
    ? `${line.slice(0, PREVIEW_CHARS - 1).trimEnd()}…`
    : line;
}

function readList<T>(key: string): T[] {
  const value = getMemoryValue(SCOPE, key);
  return Array.isArray(value) ? (value as T[]) : [];
}

export function readDeletions(): DataDeletion[] {
  return readList<DataDeletion>(DELETED_KEY);
}

export function readChats(): DataChat[] {
  const archived = new Set(readList<string>(ARCHIVED_KEY));
  const chats = new Map<string, SessionRow[]>();
  for (const row of sessionRows()) {
    chats.set(row.chat, [...(chats.get(row.chat) ?? []), row]);
  }
  const result: DataChat[] = [];
  for (const [id, rows] of chats) {
    const messageCount = rows.reduce((sum, row) => sum + row.messages, 0);
    if (messageCount === 0) continue;
    const current = rows.find((row) => row.current) ?? rows[0];
    const title =
      current.title?.trim() ||
      rows.find((row) => row.title?.trim())?.title?.trim() ||
      firstUserLine(rows.map((row) => row.id)) ||
      id;
    const lastMessageId = Math.max(
      ...rows.map((row) => row.lastMessageId ?? 0),
    );
    const updatedAt = isoDate(
      rows
        .map((row) => row.lastMessageAt ?? row.lastActive ?? '')
        .sort()
        .at(-1),
    );
    const isArchived = archived.has(id) && !id.startsWith('main-');
    result.push({
      id,
      title,
      agent: current.agent,
      updatedAt,
      messageCount,
      archived: isArchived,
      revision: createHash('sha256')
        .update(
          JSON.stringify([lastMessageId, messageCount, title, isArchived]),
        )
        .digest('hex')
        .slice(0, 16),
    });
  }
  return result.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function currentChat(id: unknown, revision: unknown): DataChat {
  if (typeof id !== 'string' || typeof revision !== 'string') {
    throw new GatewayRequestError(400, 'Expected a chat id and revision.');
  }
  const chat = readChats().find((candidate) => candidate.id === id);
  if (!chat || chat.revision !== revision) {
    throw new GatewayRequestError(
      409,
      'This chat changed. Reload and try again.',
    );
  }
  return chat;
}

export function archiveChat(
  id: unknown,
  revision: unknown,
  archived: unknown,
): void {
  if (typeof archived !== 'boolean') {
    throw new GatewayRequestError(
      400,
      'Expected archived to be true or false.',
    );
  }
  const chat = currentChat(id, revision);
  if (chat.id.startsWith('main-')) {
    throw new GatewayRequestError(400, 'Hy’s main chat can’t be archived.');
  }
  const list = new Set(readList<string>(ARCHIVED_KEY));
  if (archived) list.add(chat.id);
  else list.delete(chat.id);
  setMemoryValue(SCOPE, ARCHIVED_KEY, [...list]);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'session';
}

/** What a session leaves outside the database, by session row id. */
function removeSessionFiles(
  sessionId: string,
  agent: string,
  scope: string | null,
): void {
  // A scoped chat keeps its transcript and tool results in its scope.
  const workspace = scope
    ? scopeWorkspaceDir(agent, scope)
    : agentWorkspaceDir(agent);
  const safe = safeName(sessionId);
  deleteArchives(sessionId);
  for (const target of [
    path.join(DATA_DIR, 'sessions', safe),
    path.join(workspace, '.session-transcripts', `${safe}.jsonl`),
    path.join(workspace, '.tool-results', safe),
    path.join(workspace, '.session-exports', safe),
    path.join(
      workspace,
      '.hybridclaw-runtime',
      'sessions',
      createHash('sha256').update(sessionId).digest('hex').slice(0, 32),
    ),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Deletes every session row of the chat with what refers to it: messages,
 * summaries, recallable memories, prompt logs, ratings, the transcripts the
 * agent's session search reads, and the cross-chat context built from it.
 * Notes in the workspace stay: nothing ties a line in them to one chat.
 */
export async function deleteChat(
  id: unknown,
  revision: unknown,
  confirmation: unknown,
): Promise<void> {
  if (confirmation !== 'delete') {
    throw new GatewayRequestError(400, 'confirmation_required');
  }
  const chat = currentChat(id, revision);
  const rows = sessionRows(chat.id);
  const running = new Set(getInFlightExecutorSessionIds());
  if (rows.some((row) => running.has(row.id))) {
    throw new GatewayRequestError(
      409,
      'Hy is working. Try again when it has finished.',
    );
  }
  const lastMessageID = Math.max(
    0,
    ...rows.map((row) => row.lastMessageId ?? 0),
  );
  for (const row of rows) {
    await deleteGatewayAdminSession(row.id);
    withMemoryDatabase((db) =>
      db.transaction(() => {
        for (const table of [
          'request_log',
          'response_ratings',
          'session_branches',
        ]) {
          db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(row.id);
        }
        db.prepare('DELETE FROM kv_store WHERE agent_id = ?').run(row.id);
      })(),
    );
    removeSessionFiles(row.id, row.agent, row.scope);
  }
  for (const agent of new Set(rows.map((row) => row.agent))) {
    clearCanonicalContext({ agentId: agent, userId: chat.id });
  }
  deleteWebNotificationSession(chat.id);
  setMemoryValue(
    SCOPE,
    ARCHIVED_KEY,
    readList<string>(ARCHIVED_KEY).filter((archived) => archived !== chat.id),
  );
  setMemoryValue(
    SCOPE,
    DELETED_KEY,
    [
      ...readDeletions().filter((deletion) => deletion.id !== chat.id),
      { id: chat.id, deletedAt: new Date().toISOString(), lastMessageID },
    ].slice(-MAX_DELETIONS),
  );
}
