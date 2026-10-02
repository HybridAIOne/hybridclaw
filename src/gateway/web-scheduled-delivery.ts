/**
 * Scheduled web output is delivered to its originating conversation at run time.
 * Unlike transport queues, durable history is the delivery target; push is only
 * a best-effort alert and cannot turn a stored reminder into a failed job.
 */
import { logger } from '../logger.js';
import { memoryService } from '../memory/memory-service.js';
import type { ArtifactMetadata } from '../types/execution.js';
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
      }),
    );
  }
}

function unreadReminders(delivery: WebNotificationDelivery): number {
  return delivery.state.notifications.filter(
    (notice) => notice.kind === 'reminder',
  ).length;
}

export function deliverWebScheduledMessage(
  sessionId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
  storedMessage?: { sessionId: string; id: number },
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
  ).catch(() =>
    logger.warn('Phone alert unavailable; the reply remains in chat'),
  );
  return { status: 'delivered' };
}
