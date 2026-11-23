/**
 * One durable progress message per background delegation, in its parent chat.
 * Updates cannot recreate a deleted/reset session or edit another message.
 * Unlike delegation jobs, these rows are display history, not execution state.
 */
import type Database from 'better-sqlite3';
import type { ActivityTrace } from '../types/activity-trace.js';
import { serializeActivityTrace } from '../types/activity-trace.js';
import { withMemoryDatabase } from './database.js';
import { storeMessage } from './messages.js';
import { queryOne } from './sqlite.js';

const PROGRESS_SOURCE_PREFIX = 'delegate:progress:';

export function storeDelegationProgress(params: {
  jobId: string;
  sessionId: string;
  agentId: string;
  text: string;
  trace: ActivityTrace | null;
}): boolean {
  return withMemoryDatabase((database) =>
    database.transaction(() => {
      const active = queryOne(
        database,
        `SELECT sessions.id FROM sessions JOIN delegation_jobs ON parent_session_id = sessions.id
         WHERE sessions.id = ? AND is_current = 1 AND public_id = ?
           AND status IN ('queued', 'in_progress')`,
        params.sessionId,
        params.jobId,
      );
      if (!active) return false;
      const source = `${PROGRESS_SOURCE_PREFIX}${params.jobId}`;
      const row = queryOne<{ id: number }>(
        database,
        "SELECT id FROM messages WHERE session_id = ? AND source = ? AND role = 'assistant'",
        params.sessionId,
        source,
      );
      const id =
        row?.id ??
        storeMessage(
          params.sessionId,
          'assistant',
          null,
          'assistant',
          params.text,
          params.agentId,
          null,
          source,
        );
      database
        .prepare(
          "UPDATE messages SET content = ?, activity_trace_json = ? WHERE id = ? AND session_id = ? AND role = 'assistant'",
        )
        .run(
          params.text,
          params.trace ? serializeActivityTrace(params.trace) : null,
          id,
          params.sessionId,
        );
      return true;
    })(),
  );
}

/** Called in the job-failure transaction, including gateway restart recovery. */
export function interruptDelegationProgress(
  database: Database.Database,
  jobId: string,
): void {
  database
    .prepare(
      "UPDATE messages SET content = ?, activity_trace_json = json_remove(activity_trace_json, '$.running') WHERE source = ? AND role = 'assistant'",
    )
    .run('Delegated work interrupted.', `${PROGRESS_SOURCE_PREFIX}${jobId}`);
}
