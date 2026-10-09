/**
 * The owner's phone lists what each agent remembers and changes it one item at
 * a time: workspace notes (USER.md, MEMORY.md, daily notes), chat summaries,
 * and read-only shared memory synced from HybridAI. Every change names the
 * revision it was based on and is refused while the agent runs a turn, so a
 * stale screen never overwrites what the agent just wrote. The same routes
 * list, archive and delete the phone's chats (`data-controls-chats.ts`) and
 * build the data export (`data-controls-export.ts`).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  waitForMemoryFileLock,
  writeMemoryFileAtomic,
} from '../../container/shared/memory-file.js';
import { getInFlightExecutorSessionIds } from '../agent/executor.js';
import {
  listAgents,
  resolveAgentWorkspaceId,
} from '../agents/agent-registry.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import {
  loadCloudMemoryContextFiles,
  scheduleCloudMemorySync,
} from '../memory/cloud-memory.js';
import { withMemoryDatabase } from '../memory/database.js';
import { DATA_CONTROLS_PATH } from '../security/admin-rbac.js';
import { isRecord } from '../utils/type-guards.js';
import { readWorkspaceTemplate } from '../workspace-templates.js';
import {
  archiveChat,
  type DataChat,
  type DataDeletion,
  deleteChat,
  readChats,
  readDeletions,
} from './data-controls-chats.js';
import { buildDataExport } from './data-controls-export.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { MAX_MARKDOWN_BYTES } from './system-files.js';

export { DATA_CONTROLS_PATH };

const DAILY_NOTE = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;
const TEMPLATE_NOTES = new Set(['USER.md', 'MEMORY.md']);

export interface DataMemory {
  id: string;
  agent: string;
  kind: 'note' | 'summary' | 'shared';
  title: string;
  content: string;
  revision: string;
}

export interface DataControlsSnapshot {
  version: 1;
  chats: DataChat[];
  memories: DataMemory[];
  deletedChats: string[];
  deletions: DataDeletion[];
  memoryRevision: string;
}

function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** One agent per workspace: agents sharing a workspace share its notes. */
function workspaceAgents(): string[] {
  const seen = new Set<string>();
  const agents: string[] = [];
  for (const agent of listAgents()) {
    if (agent.archived) continue;
    const workspace = resolveAgentWorkspaceId(agent.id);
    if (seen.has(workspace)) continue;
    seen.add(workspace);
    agents.push(agent.id);
  }
  return agents;
}

function noteFiles(agentId: string): string[] {
  const root = agentWorkspaceDir(agentId);
  const files = ['USER.md', 'MEMORY.md'];
  try {
    for (const name of fs.readdirSync(path.join(root, 'memory')).sort()) {
      const relative = `memory/${name}`;
      if (DAILY_NOTE.test(relative)) files.push(relative);
    }
  } catch {}
  return files;
}

function readNote(agentId: string, relative: string): string | null {
  const file = path.join(agentWorkspaceDir(agentId), relative);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readDataControls(): DataControlsSnapshot {
  const agents = workspaceAgents();
  const memories: DataMemory[] = [];
  for (const agent of agents) {
    for (const relative of noteFiles(agent)) {
      const content = readNote(agent, relative);
      // An untouched USER.md or MEMORY.md holds nothing Hy learned.
      if (!content?.trim() || content === readWorkspaceTemplate(relative)) {
        continue;
      }
      memories.push({
        id: `note:${agent}:${relative}`,
        agent,
        kind: 'note',
        title: relative,
        content,
        revision: revisionOf(content),
      });
    }
  }
  const known = new Set(listAgents().map((agent) => agent.id));
  const summaries = withMemoryDatabase(
    (db) =>
      db
        .prepare(
          `SELECT id, agent_id AS agent, session_summary AS content
           FROM sessions
           WHERE session_summary IS NOT NULL AND TRIM(session_summary) != ''
           ORDER BY summary_updated_at DESC`,
        )
        .all() as Array<{ id: string; agent: string; content: string }>,
  );
  for (const summary of summaries) {
    if (!known.has(summary.agent)) continue;
    memories.push({
      id: `summary:${summary.id}`,
      agent: summary.agent,
      kind: 'summary',
      title: summary.id,
      content: summary.content,
      revision: revisionOf(summary.content),
    });
  }
  const shared = new Set<string>();
  for (const agent of agents) {
    for (const file of loadCloudMemoryContextFiles(agent)) {
      const id = `shared:${file.scope}:${file.name}`;
      if (shared.has(id) || !file.content.trim()) continue;
      shared.add(id);
      memories.push({
        id,
        agent,
        kind: 'shared',
        title: file.name,
        content: file.content,
        revision: revisionOf(file.content),
      });
    }
  }
  const deletions = readDeletions();
  return {
    version: 1,
    chats: readChats(),
    memories,
    deletedChats: deletions.map((deletion) => deletion.id),
    deletions,
    memoryRevision: revisionOf(
      memories
        .filter((memory) => memory.kind !== 'shared')
        .map((memory) => `${memory.id}\n${memory.revision}`)
        .join('\n'),
    ),
  };
}

/** Refused while any agent sharing `agentId`'s workspace runs a turn. */
function refuseWhileWorking(agentId?: string): void {
  const running = getInFlightExecutorSessionIds();
  if (running.length === 0) return;
  const workspace = agentId && resolveAgentWorkspaceId(agentId);
  const agents = new Set(
    listAgents()
      .filter(
        (agent) =>
          !workspace || resolveAgentWorkspaceId(agent.id) === workspace,
      )
      .map((agent) => agent.id),
  );
  if (agentId) agents.add(agentId);
  const sessions = withMemoryDatabase(
    (db) =>
      db
        .prepare(
          `SELECT agent_id AS agent FROM sessions WHERE id IN (${running.map(() => '?').join(', ')})`,
        )
        .all(...running) as Array<{ agent: string }>,
  );
  if (sessions.some(({ agent }) => !agentId || agents.has(agent))) {
    throw new GatewayRequestError(
      409,
      'Hy is working. Try again when it has finished.',
    );
  }
}

type Target =
  | { kind: 'note'; agent: string; relative: string }
  | { kind: 'summary'; session: string; agent: string };

function resolveTarget(id: unknown): Target {
  if (typeof id !== 'string') {
    throw new GatewayRequestError(400, 'Expected a memory id.');
  }
  const note = /^note:([^:]+):(.+)$/.exec(id);
  if (note) {
    const [, agent, relative] = note;
    if (
      workspaceAgents().includes(agent) &&
      (TEMPLATE_NOTES.has(relative) || DAILY_NOTE.test(relative))
    ) {
      return { kind: 'note', agent, relative };
    }
  }
  const summary = /^summary:(.+)$/.exec(id);
  if (summary) {
    const owner = withMemoryDatabase(
      (db) =>
        db
          .prepare('SELECT agent_id AS agent FROM sessions WHERE id = ?')
          .get(summary[1]) as { agent: string } | undefined,
    );
    if (owner)
      return { kind: 'summary', session: summary[1], agent: owner.agent };
  }
  if (id.startsWith('shared:')) {
    throw new GatewayRequestError(
      403,
      'Shared memories are managed in their connected workspace.',
    );
  }
  throw new GatewayRequestError(
    409,
    'This memory changed. Reload and try again.',
  );
}

/**
 * Writes `content` over a note, or removes it when `content` is null: USER.md
 * and MEMORY.md go back to their shipped template, daily notes are deleted.
 */
async function changeNote(
  agent: string,
  relative: string,
  revision: string | null,
  content: string | null,
): Promise<void> {
  const file = path.join(agentWorkspaceDir(agent), relative);
  let unlock: () => void;
  try {
    unlock = await waitForMemoryFileLock(file);
  } catch {
    throw new GatewayRequestError(
      409,
      'Hy is working. Try again when it has finished.',
    );
  }
  try {
    const current = readNote(agent, relative);
    if (
      revision !== null &&
      (current === null || revisionOf(current) !== revision)
    ) {
      throw new GatewayRequestError(
        409,
        'This memory changed. Reload and try again.',
      );
    }
    if (content !== null) {
      writeMemoryFileAtomic(file, content);
    } else if (TEMPLATE_NOTES.has(relative)) {
      writeMemoryFileAtomic(file, readWorkspaceTemplate(relative) ?? '');
    } else {
      fs.rmSync(file, { force: true });
    }
  } finally {
    unlock();
  }
}

/**
 * Compaction also files each summary as a recallable memory; it follows the
 * summary so an edited or deleted summary is not recalled in its old words.
 * The lexical index follows through its triggers; the stale embedding is
 * dropped until the memory is stored again.
 */
function changeSummary(
  session: string,
  revision: string | null,
  content: string | null,
): void {
  withMemoryDatabase((db) =>
    db.transaction(() => {
      const row = db
        .prepare('SELECT session_summary AS summary FROM sessions WHERE id = ?')
        .get(session) as { summary: string | null } | undefined;
      const current = row?.summary ?? null;
      if (
        current === null ||
        (revision !== null && revisionOf(current) !== revision)
      ) {
        throw new GatewayRequestError(
          409,
          'This memory changed. Reload and try again.',
        );
      }
      db.prepare(
        "UPDATE sessions SET session_summary = ?, summary_updated_at = datetime('now') WHERE id = ?",
      ).run(content, session);
      if (content === null) {
        db.prepare(
          `UPDATE semantic_memories SET deleted = 1
           WHERE session_id = ? AND source = 'compaction' AND content = ? AND deleted = 0`,
        ).run(session, current);
      } else {
        db.prepare(
          `UPDATE semantic_memories SET content = ?, embedding = NULL
           WHERE session_id = ? AND source = 'compaction' AND content = ? AND deleted = 0`,
        ).run(content, session, current);
      }
    })(),
  );
}

async function deleteAll(revision: unknown): Promise<void> {
  if (
    typeof revision !== 'string' ||
    readDataControls().memoryRevision !== revision
  ) {
    throw new GatewayRequestError(
      409,
      'Your memories changed. Reload and try again.',
    );
  }
  refuseWhileWorking();
  for (const memory of readDataControls().memories) {
    if (memory.kind === 'shared') continue;
    const target = resolveTarget(memory.id);
    if (target.kind === 'note') {
      await changeNote(target.agent, target.relative, null, null);
    } else {
      changeSummary(target.session, null, null);
    }
  }
  for (const agent of workspaceAgents()) scheduleCloudMemorySync(agent);
}

export async function handleDataControlsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const action = pathname.slice(DATA_CONTROLS_PATH.length);
  try {
    if (action === '') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: 'Method not allowed.' });
        return;
      }
      sendJson(res, 200, { ...readDataControls() });
      return;
    }
    if (action === '/export') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: 'Method not allowed.' });
        return;
      }
      const snapshot = readDataControls();
      const zip = await buildDataExport({
        agents: workspaceAgents(),
        memories: snapshot.memories,
      });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': zip.length,
        'Content-Disposition': 'attachment; filename="Hy-data.zip"',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(zip);
      return;
    }
    if (
      ![
        '/memories/delete',
        '/memories/delete-all',
        '/memories/update',
        '/chats/archive',
        '/chats/delete',
      ].includes(action)
    ) {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }
    // JSON escaping can expand one content byte to six bytes.
    const body = await readJsonBody(req, 6 * MAX_MARKDOWN_BYTES + 1024);
    if (!isRecord(body))
      throw new GatewayRequestError(400, 'Expected a JSON object.');
    if (action === '/chats/archive') {
      archiveChat(body.id, body.revision, body.archived);
    } else if (action === '/chats/delete') {
      await deleteChat(body.id, body.revision, body.confirmation);
    } else if (action === '/memories/delete-all') {
      if (body.confirmation !== 'delete') {
        throw new GatewayRequestError(400, 'confirmation_required');
      }
      await deleteAll(body.revision);
    } else {
      const update = action === '/memories/update';
      if (typeof body.revision !== 'string') {
        throw new GatewayRequestError(400, 'Expected a revision.');
      }
      if (!update && body.confirmation !== 'delete') {
        throw new GatewayRequestError(400, 'confirmation_required');
      }
      let content: string | null = null;
      if (update) {
        if (typeof body.content !== 'string' || !body.content.trim()) {
          throw new GatewayRequestError(400, 'Expected the new text.');
        }
        if (Buffer.byteLength(body.content) > MAX_MARKDOWN_BYTES) {
          throw new GatewayRequestError(413, 'This memory is too long.');
        }
        content = body.content;
      }
      const target = resolveTarget(body.id);
      refuseWhileWorking(target.agent);
      if (target.kind === 'note') {
        await changeNote(target.agent, target.relative, body.revision, content);
        scheduleCloudMemorySync(target.agent);
      } else {
        changeSummary(target.session, body.revision, content?.trim() ?? null);
      }
    }
    sendJson(res, 200, { ...readDataControls() });
  } catch (error) {
    if (!(error instanceof GatewayRequestError)) throw error;
    sendJson(res, error.statusCode, { error: error.message });
  }
}
