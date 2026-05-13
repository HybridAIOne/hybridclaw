import { logger } from '../logger.js';
import { withMemoryDatabase } from '../memory/db.js';
import type { Session } from '../types/session.js';

export type ThreadGoalStatus = 'active' | 'paused' | 'done' | 'cleared';

export interface GoalSetterActor {
  type: 'user' | 'agent' | 'system';
  id: string;
  name?: string | null;
}

export interface ThreadGoal {
  threadId: string;
  goalText: string;
  status: ThreadGoalStatus;
  turnsUsed: number;
  maxTurns: number;
  createdAt: string;
  lastTurnAt: string | null;
  lastVerdict: string | null;
  lastReason: string | null;
  pausedReason: string | null;
  consecutiveParseFailures: number;
  setterActor: GoalSetterActor | null;
  targetAgentId: string | null;
}

interface ThreadGoalRow {
  thread_id: string;
  goal_text: string;
  status: ThreadGoalStatus;
  turns_used: number;
  max_turns: number;
  created_at: string;
  last_turn_at: string | null;
  last_verdict: string | null;
  last_reason: string | null;
  paused_reason: string | null;
  consecutive_parse_failures: number;
  setter_actor: string | null;
  target_agent_id: string | null;
}

export const DEFAULT_GOAL_MAX_TURNS = 20;
export const MAX_GOAL_MAX_TURNS = 64;
export const GOAL_PARSE_FAILURE_PAUSE_THRESHOLD = 3;
export const MAX_GOAL_TEXT_LENGTH = 4_000;

const THREAD_GOAL_COLUMNS = `thread_id, goal_text, status, turns_used, max_turns, created_at,
  last_turn_at, last_verdict, last_reason, paused_reason,
  consecutive_parse_failures, setter_actor, target_agent_id`;

export function resolveGoalThreadId(session: Session): string {
  return (
    session.main_session_key?.trim() ||
    session.session_key?.trim() ||
    session.id.trim()
  );
}

export function normalizeGoalMaxTurns(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GOAL_MAX_TURNS;
  const truncated = Math.trunc(parsed);
  if (truncated < 1) return DEFAULT_GOAL_MAX_TURNS;
  return Math.min(MAX_GOAL_MAX_TURNS, truncated);
}

export function normalizeGoalText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_GOAL_TEXT_LENGTH);
}

function serializeSetterActor(actor: GoalSetterActor | null): string | null {
  if (!actor) return null;
  const id = actor.id.trim();
  if (!id) return null;
  return JSON.stringify({
    type: actor.type,
    id,
    ...(actor.name?.trim() ? { name: actor.name.trim() } : {}),
  });
}

function parseSetterActor(raw: string | null): GoalSetterActor | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GoalSetterActor>;
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
    const type = parsed.type;
    if (!id || (type !== 'user' && type !== 'agent' && type !== 'system')) {
      return null;
    }
    return {
      type,
      id,
      ...(typeof parsed.name === 'string' && parsed.name.trim()
        ? { name: parsed.name.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

function mapThreadGoal(row: ThreadGoalRow): ThreadGoal {
  return {
    threadId: row.thread_id,
    goalText: row.goal_text,
    status: row.status,
    turnsUsed: Math.max(0, Math.floor(row.turns_used || 0)),
    maxTurns: normalizeGoalMaxTurns(row.max_turns),
    createdAt: row.created_at,
    lastTurnAt: row.last_turn_at,
    lastVerdict: row.last_verdict,
    lastReason: row.last_reason,
    pausedReason: row.paused_reason,
    consecutiveParseFailures: Math.max(
      0,
      Math.floor(row.consecutive_parse_failures || 0),
    ),
    setterActor: parseSetterActor(row.setter_actor),
    targetAgentId: row.target_agent_id,
  };
}

function defaultExpectedStatuses(status: ThreadGoalStatus): ThreadGoalStatus[] {
  switch (status) {
    case 'paused':
    case 'done':
      return ['active'];
    case 'cleared':
      return ['active', 'paused', 'done'];
    case 'active':
      throw new Error(
        'Use resumeThreadGoal or pass expectedStatuses when activating a goal.',
      );
    default: {
      const exhaustive: never = status;
      throw new Error(`Unsupported goal status transition: ${exhaustive}`);
    }
  }
}

export function getThreadGoal(threadId: string): ThreadGoal | null {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) return null;
  return withMemoryDatabase((database) => {
    const row = database
      .prepare(
        `SELECT ${THREAD_GOAL_COLUMNS}
           FROM thread_goals
          WHERE thread_id = ?`,
      )
      .get(normalizedThreadId) as ThreadGoalRow | undefined;
    return row ? mapThreadGoal(row) : null;
  });
}

export function getActiveThreadGoal(threadId: string): ThreadGoal | null {
  const goal = getThreadGoal(threadId);
  return goal?.status === 'active' ? goal : null;
}

export function setThreadGoal(params: {
  threadId: string;
  goalText: string;
  maxTurns?: number;
  setterActor: GoalSetterActor | null;
  targetAgentId: string | null;
}): ThreadGoal {
  const threadId = params.threadId.trim();
  const normalizedInput = params.goalText.replace(/\s+/g, ' ').trim();
  const goalText = normalizedInput.slice(0, MAX_GOAL_TEXT_LENGTH);
  if (!threadId) throw new Error('Goal thread id is required.');
  if (!goalText) throw new Error('Goal text is required.');
  if (normalizedInput.length > MAX_GOAL_TEXT_LENGTH) {
    logger.warn(
      {
        threadId,
        originalLength: normalizedInput.length,
        maxLength: MAX_GOAL_TEXT_LENGTH,
      },
      'Goal text exceeded maximum length and was truncated',
    );
  }
  const maxTurns = normalizeGoalMaxTurns(params.maxTurns);
  const setterActor = serializeSetterActor(params.setterActor);
  const targetAgentId = params.targetAgentId?.trim() || null;
  return withMemoryDatabase((database) => {
    const row = database
      .prepare(
        `INSERT INTO thread_goals (
           thread_id, goal_text, status, turns_used, max_turns, created_at,
           last_turn_at, last_verdict, last_reason, paused_reason,
           consecutive_parse_failures, setter_actor, target_agent_id
         )
         VALUES (?, ?, 'active', 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 NULL, NULL, NULL, NULL, 0, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           goal_text = excluded.goal_text,
           status = 'active',
           turns_used = 0,
           max_turns = excluded.max_turns,
           created_at = excluded.created_at,
           last_turn_at = NULL,
           last_verdict = NULL,
           last_reason = NULL,
           paused_reason = NULL,
           consecutive_parse_failures = 0,
           setter_actor = excluded.setter_actor,
           target_agent_id = excluded.target_agent_id
         RETURNING ${THREAD_GOAL_COLUMNS}`,
      )
      .get(threadId, goalText, maxTurns, setterActor, targetAgentId) as
      | ThreadGoalRow
      | undefined;
    if (!row) throw new Error('Failed to persist goal.');
    return mapThreadGoal(row);
  });
}

export function updateThreadGoalStatus(params: {
  threadId: string;
  status: ThreadGoalStatus;
  reason?: string | null;
  verdict?: string | null;
  resetParseFailures?: boolean;
  expectedStatuses?: ThreadGoalStatus[];
}): ThreadGoal | null {
  const threadId = params.threadId.trim();
  if (!threadId) return null;
  const reason = params.reason?.trim() || null;
  const verdict = params.verdict?.trim() || params.status;
  const expectedStatuses =
    params.expectedStatuses && params.expectedStatuses.length > 0
      ? params.expectedStatuses
      : defaultExpectedStatuses(params.status);
  return withMemoryDatabase((database) => {
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const row = database
      .prepare(
        `UPDATE thread_goals
            SET status = ?,
                paused_reason = CASE WHEN ? = 'paused' THEN ? ELSE NULL END,
                last_verdict = ?,
                last_reason = ?,
                consecutive_parse_failures = CASE WHEN ? THEN 0 ELSE consecutive_parse_failures END
          WHERE thread_id = ?
            AND status IN (${placeholders})
         RETURNING ${THREAD_GOAL_COLUMNS}`,
      )
      .get(
        params.status,
        params.status,
        reason,
        verdict,
        reason,
        params.resetParseFailures === true ? 1 : 0,
        threadId,
        ...expectedStatuses,
      ) as ThreadGoalRow | undefined;
    return row ? mapThreadGoal(row) : null;
  });
}

export function recordThreadGoalTurn(params: {
  threadId: string;
  verdict: string;
  reason: string;
  parseFailure?: boolean;
}): ThreadGoal | null {
  const threadId = params.threadId.trim();
  if (!threadId) return null;
  const verdict = params.verdict.trim() || 'active';
  const reason = params.reason.trim() || null;
  return withMemoryDatabase((database) => {
    const row = database
      .prepare(
        `UPDATE thread_goals
            SET turns_used = turns_used + 1,
                last_turn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                last_verdict = ?,
                last_reason = ?,
                consecutive_parse_failures = CASE
                  WHEN ? THEN consecutive_parse_failures + 1
                  ELSE 0
                END
          WHERE thread_id = ?
            AND status = 'active'
         RETURNING ${THREAD_GOAL_COLUMNS}`,
      )
      .get(verdict, reason, params.parseFailure === true ? 1 : 0, threadId) as
      | ThreadGoalRow
      | undefined;
    return row ? mapThreadGoal(row) : null;
  });
}

export function resumeThreadGoal(threadId: string): ThreadGoal | null {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) return null;
  return withMemoryDatabase((database) => {
    const row = database
      .prepare(
        `UPDATE thread_goals
            SET status = 'active',
                paused_reason = NULL,
                last_verdict = 'resumed',
                last_reason = NULL
          WHERE thread_id = ?
            AND status = 'paused'
         RETURNING ${THREAD_GOAL_COLUMNS}`,
      )
      .get(normalizedThreadId) as ThreadGoalRow | undefined;
    return row ? mapThreadGoal(row) : null;
  });
}
