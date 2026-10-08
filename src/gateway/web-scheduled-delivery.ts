/**
 * Scheduled web output is delivered at run time to its agent's main chat, or
 * to the conversation that created the task when that agent has none. Unlike
 * transport queues, durable history is the delivery target; push is only a
 * best-effort alert and cannot turn a stored reminder into a failed job.
 */

import { logger } from '../logger.js';
import {
  getAgentMainSession,
  isAppDataChat,
} from '../memory/agent-main-session.js';
import { memoryService } from '../memory/memory-service.js';
import type { ArtifactMetadata } from '../types/execution.js';
import type { Session } from '../types/session.js';
import { skipWorkNotification } from '../work/work-delivery.js';
import { updateWork } from '../work/work-store.js';
import {
  notifyWebSession,
  type WebNotificationDelivery,
} from './web-notifications.js';

/**
 * Rings the chat owner's phones after the reply is stored. A reminder shows
 * the assistant's name and the reminder itself. A task added with `--alert`
 * rings with the first item its reply lists instead, and not at all when it
 * lists none, so a phone never shows such a reply's raw list. With
 * `--reply-only` as well, the reply is a message written for the chat, so it
 * rings like a reminder of the alert's kind. Best effort: looked up after the
 * reply is stored, and a failure only loses the alert.
 */
async function alertPhones(
  delivery: WebNotificationDelivery | null,
  source: string,
  sessionId: string,
  agentId: string,
  text: string,
  messageId: number,
  workId?: string,
): Promise<void> {
  const taskId = /^schedule:(\d+)$/.exec(source)?.[1];
  const task = taskId
    ? (await import('../memory/jobs.js')).getJob(Number(taskId), {
        kind: 'scheduled_task',
      })
    : null;
  const alert = task?.alert;
  const reminder =
    !alert && delivery?.devices.length && delivery.state.preferences.reminder;
  if (!alert && !reminder) return;
  const [{ getAgentById }, push] = await Promise.all([
    import('../agents/agent-registry.js'),
    import('./mobile-push.js'),
  ]);
  const agent = getAgentById(agentId);
  const assistant = push.phoneAssistantName(agentId, agent);
  if (alert && task?.reply_only) {
    if (!delivery) return;
    await push.sendMobilePush(delivery.devices, {
      ...push.reminderAlert({
        notification: delivery.notification,
        assistant,
        text,
        unread: unreadReminders(delivery),
        messageId,
        workId,
      }),
      kind: alert,
    });
  } else if (alert) {
    await push.alertListedItems({
      sessionId,
      kind: alert,
      assistant,
      text,
      messageId,
      workId,
    });
  } else if (delivery) {
    await push.sendMobilePush(
      delivery.devices,
      push.reminderAlert({
        notification: delivery.notification,
        assistant,
        text,
        unread: unreadReminders(delivery),
        messageId,
        workId,
      }),
    );
  }
}

function unreadReminders(delivery: WebNotificationDelivery): number {
  return delivery.state.notifications.filter(
    (notice) => notice.kind === 'reminder',
  ).length;
}

/**
 * Where a web task's replies go instead of the chat that created it: its
 * agent's main chat (2026-10-08, product owner: Hy's crons always reach the
 * main chat, never a side chat the user rarely opens). Null when the task's
 * chat is not a web chat, is the main chat itself, is one of the apps' hidden
 * data chats, or its agent has none.
 * Looked up per run, so stored tasks follow a new main chat.
 */
export function mainChatForWebTask(taskSessionId: string): Session | null {
  const origin = memoryService.getSessionById(taskSessionId);
  if (origin?.channel_id !== 'web' || isAppDataChat(origin.session_key))
    return null;
  const main = getAgentMainSession(origin.agent_id);
  return main && main.session_key !== origin.session_key ? main : null;
}

export function deliverWebScheduledMessage(
  sessionId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
  storedMessage?: { sessionId: string; id: number },
  workId?: string,
): { status: 'delivered' } {
  const session = memoryService.getSessionById(sessionId);
  if (session?.channel_id !== 'web')
    throw new Error('Scheduled web delivery requires an existing web session.');
  const messageId =
    storedMessage?.sessionId === session.id
      ? storedMessage.id
      : memoryService.storeMessage({
          sessionId: session.id,
          userId: 'scheduler',
          username: 'HybridClaw',
          role: 'assistant',
          content: text,
          agentId: session.agent_id,
          artifacts,
          source,
        });
  if (workId)
    updateWork(workId, (work) => {
      work.sessionId = session.id;
      work.messageId = messageId;
      work.savedAt ??= new Date().toISOString();
    });
  const delivery = notifyWebSession(
    session.id,
    'reminder',
    String(messageId),
    undefined,
    { phone: false },
  );
  void alertPhones(
    delivery,
    source,
    session.id,
    session.agent_id,
    text,
    messageId,
    workId,
  )
    .then(() => skipWorkNotification(workId, 'not_requested'))
    .catch(() => {
      skipWorkNotification(workId, 'alert_unavailable');
      logger.warn('Phone alert unavailable; the reply remains in chat');
    });
  return { status: 'delivered' };
}
