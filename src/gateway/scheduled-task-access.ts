/**
 * Cron task access follows the originating session, except among web chats
 * owned by the same agent. Messaging-channel sessions stay isolated so one
 * peer cannot list or change another peer's schedules.
 *
 * NOT the admin scheduler, which deliberately operates across all jobs.
 */
import { getSessionById } from '../memory/db.js';
import { getAllJobs } from '../memory/jobs.js';
import { resolveSessionIdCompat } from '../memory/sessions.js';
import type { ScheduledTask } from '../types/scheduler.js';
import type { Session } from '../types/session.js';

export function canManageScheduledTask(
  task: ScheduledTask,
  requester: Session,
): boolean {
  if (task.session_id === resolveSessionIdCompat(requester.id)) return true;
  if (requester.channel_id !== 'web' || !requester.agent_id) return false;
  const owner = getSessionById(task.session_id);
  return owner?.channel_id === 'web' && owner.agent_id === requester.agent_id;
}

export function listManageableScheduledTasks(
  requester: Session,
): ScheduledTask[] {
  if (requester.channel_id !== 'web') {
    return getAllJobs({ kind: 'scheduled_task', sessionId: requester.id });
  }
  return getAllJobs({ kind: 'scheduled_task' }).filter((task) =>
    canManageScheduledTask(task, requester),
  );
}
