/**
 * Records transport attempts and explicit viewing separately from execution.
 * A lost response stays an unknown attempt; notification inbox cleanup is not viewing.
 */
import { webNotificationSessionOperator } from '../gateway/web-notification-store.js';
import { readWork, updateWork } from './work-store.js';

export function skipWorkNotification(
  id: string | undefined,
  reason: string,
): void {
  if (id)
    updateWork(id, (work) => {
      if (!work.attempts.length && !work.notificationSkipped)
        work.notificationSkipped = reason;
    });
}
export async function recordWorkPush<T>(
  id: string | undefined,
  send: () => Promise<T>,
): Promise<T> {
  if (!id) return send();
  let index = 0;
  updateWork(id, (work) => {
    index = work.attempts.length;
    work.attempts.push({
      at: new Date().toISOString(),
      finishedAt: null,
      accepted: 0,
      error: null,
    });
    work.notificationSkipped = null;
  });
  try {
    const result = await send();
    updateWork(id, (work) => {
      const attempt = work.attempts[index];
      attempt.finishedAt = new Date().toISOString();
      attempt.accepted = result === 'sent' ? 1 : 0;
      attempt.error = result === 'sent' ? null : 'relay_refused';
    });
    return result;
  } catch (error) {
    updateWork(id, (work) => {
      work.attempts[index].finishedAt = new Date().toISOString();
      work.attempts[index].error = 'relay_unavailable';
    });
    throw error;
  }
}
export function markWorkSeen(id: string, operator: string): void {
  const work = readWork(id);
  if (
    !work?.savedAt ||
    webNotificationSessionOperator(work.sessionId) !== operator
  )
    return;
  updateWork(id, (record) => {
    record.seenAt ??= new Date().toISOString();
  });
}
