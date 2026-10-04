/**
 * Durable provenance for one execution, shared by its outputs and delivery receipts.
 * Execution, chat storage, transport acceptance and viewing are independent facts.
 * Unlike audit logs this stores the stated reason; it never infers one from a reply.
 */
import { withMemoryDatabase } from '../memory/database.js';
import { queryAll, queryOne } from '../memory/sqlite.js';

export interface WorkEvidence {
  reference: string;
  summary: string;
}
export interface WorkRecord {
  id: string;
  agentId: string;
  owner: string | null;
  sessionId: string;
  runSessionId: string;
  taskId: number | null;
  startedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  savedAt: string | null;
  messageId: number | null;
  seenAt: string | null;
  rationale: string | null;
  evidence: WorkEvidence[];
  artifacts: string[];
  actions: { toolCallId: string; tool: string; ok: boolean }[];
  attempts: {
    at: string;
    finishedAt: string | null;
    accepted: number;
    error: string | null;
  }[];
  notificationSkipped: string | null;
}

export function readWork(id: string): WorkRecord | null {
  return withMemoryDatabase((db) => {
    const row = queryOne<{ data: string }>(
      db,
      'SELECT data FROM work_records WHERE id = ?',
      id,
    );
    return row ? (JSON.parse(row.data) as WorkRecord) : null;
  });
}
export function workForMessage(
  session: string,
  message: number,
): WorkRecord | null {
  return withMemoryDatabase((db) => {
    const row = queryOne<{ data: string }>(
      db,
      'SELECT data FROM work_records WHERE session_id = ? AND message_id = ?',
      session,
      message,
    );
    return row ? (JSON.parse(row.data) as WorkRecord) : null;
  });
}
export function listWork(agent: string, owner: string): WorkRecord[] {
  return withMemoryDatabase((db) =>
    queryAll<{ data: string }>(
      db,
      'SELECT data FROM work_records WHERE agent_id = ? AND owner = ? ORDER BY rowid DESC LIMIT 50',
      agent,
      owner,
    ).map((row) => JSON.parse(row.data) as WorkRecord),
  );
}
export function startWork(
  input: Pick<
    WorkRecord,
    'id' | 'agentId' | 'owner' | 'sessionId' | 'runSessionId' | 'taskId'
  >,
): void {
  const work: WorkRecord = {
    ...input,
    startedAt: new Date().toISOString(),
    completedAt: null,
    failedAt: null,
    savedAt: null,
    messageId: null,
    seenAt: null,
    rationale: null,
    evidence: [],
    artifacts: [],
    actions: [],
    attempts: [],
    notificationSkipped: null,
  };
  withMemoryDatabase((db) =>
    db
      .prepare(
        'INSERT INTO work_records (id, agent_id, owner, session_id, data) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        work.id,
        work.agentId,
        work.owner,
        work.sessionId,
        JSON.stringify(work),
      ),
  );
}
export function updateWork(
  id: string,
  change: (work: WorkRecord) => void,
): void {
  withMemoryDatabase((db) =>
    db.transaction(() => {
      const work = readWork(id);
      if (!work) throw new Error('Work not found.');
      change(work);
      db.prepare(
        'UPDATE work_records SET session_id = ?, message_id = ?, data = ? WHERE id = ?',
      ).run(work.sessionId, work.messageId, JSON.stringify(work), id);
    })(),
  );
}
