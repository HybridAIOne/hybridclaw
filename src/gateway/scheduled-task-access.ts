/**
 * Which sessions a chat may see: its own (across resets of the same chat),
 * and among web chats every chat of the same agent; a scoped web chat only
 * those of its scope. Messaging-channel sessions stay isolated so one peer
 * cannot list or change another peer's schedules or read another peer's
 * audit trail. Cron task access follows the
 * session the task was created in; a task's results are also readable from
 * the agent's main chat its web replies are delivered to.
 *
 * NOT the admin scheduler or admin audit, which deliberately operate across
 * all sessions for the local operator.
 */
import { getSessionById } from '../memory/db.js';
import { getAllJobs } from '../memory/jobs.js';
import { resolveSessionIdCompat } from '../memory/sessions.js';
import type { ScheduledTask } from '../types/scheduler.js';
import type { Session } from '../types/session.js';
import { mainChatForWebTask } from './web-scheduled-delivery.js';

/**
 * Whether `sessionId` is an instance of the `requester` chat. A chat keeps its
 * session key when an idle or daily reset gives it a new session id, and what
 * it did stays with the id it was done under.
 */
function isSameChat(sessionId: string, requester: Session): boolean {
  if (sessionId === resolveSessionIdCompat(requester.id)) return true;
  const key = getSessionById(sessionId)?.session_key;
  return Boolean(key) && key === requester.session_key;
}

export function canSeeSession(sessionId: string, requester: Session): boolean {
  if (isSameChat(sessionId, requester)) return true;
  if (requester.channel_id !== 'web' || !requester.agent_id) return false;
  const owner = getSessionById(sessionId);
  // A scoped chat sees only its scope's chats; the others see every web chat.
  if (requester.scope && owner?.scope !== requester.scope) return false;
  return owner?.channel_id === 'web' && owner.agent_id === requester.agent_id;
}

/** Whether `requester` is the chat that created the task. */
function isCreatingChat(task: ScheduledTask, requester: Session): boolean {
  return isSameChat(task.session_id, requester);
}

/**
 * Whether `requester` may read what the task's runs answered: the chat that
 * created it, or the main chat its replies go to. A run can quote private
 * data, so the agent's other chats may manage the task but not read this.
 */
export function canReadScheduledTaskResults(
  task: ScheduledTask,
  requester: Session,
): boolean {
  if (isCreatingChat(task, requester)) return true;
  const mainChat = mainChatForWebTask(task.session_id);
  return mainChat !== null && mainChat.session_key === requester.session_key;
}

export function canManageScheduledTask(
  task: ScheduledTask,
  requester: Session,
): boolean {
  return canSeeSession(task.session_id, requester);
}

/**
 * `hiddenCount` is how many of the agent's tasks a web chat may not manage,
 * so `cron list` can say they exist instead of "No scheduled tasks." and the
 * model does not create a duplicate. Messaging sessions and scoped chats
 * always get 0: they must not learn what other chats have scheduled.
 */
export function listManageableScheduledTasks(requester: Session): {
  tasks: ScheduledTask[];
  hiddenCount: number;
} {
  if (requester.channel_id !== 'web') {
    return {
      tasks: getAllJobs({ kind: 'scheduled_task' }).filter((task) =>
        isCreatingChat(task, requester),
      ),
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
      !requester.scope &&
      getSessionById(task.session_id)?.agent_id === requester.agent_id
    ) {
      hiddenCount += 1;
    }
  }
  return { tasks, hiddenCount };
}
