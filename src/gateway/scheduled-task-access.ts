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

/**
 * `hiddenCount` is how many of the agent's tasks a web chat may not manage,
 * so `cron list` can say they exist instead of "No scheduled tasks." and the
 * model does not create a duplicate. Messaging sessions always get 0: a peer
 * must not learn that other peers have schedules.
 */
export function listManageableScheduledTasks(requester: Session): {
  tasks: ScheduledTask[];
  hiddenCount: number;
} {
  if (requester.channel_id !== 'web') {
    return {
      tasks: getAllJobs({ kind: 'scheduled_task', sessionId: requester.id }),
      hiddenCount: 0,
    };
  }
  const tasks: ScheduledTask[] = [];
  let hiddenCount = 0;
  for (const task of getAllJobs({ kind: 'scheduled_task' })) {
    if (canManageScheduledTask(task, requester)) {
      tasks.push(task);
    } else if (
      requester.agent_id &&
      getSessionById(task.session_id)?.agent_id === requester.agent_id
    ) {
      hiddenCount += 1;
    }
  }
  return { tasks, hiddenCount };
}
