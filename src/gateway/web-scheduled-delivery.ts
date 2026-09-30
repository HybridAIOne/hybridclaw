/**
 * Scheduled web output is delivered to its originating conversation at run time.
 * Unlike transport queues, durable history is the delivery target; push is only
 * a best-effort alert and cannot turn a stored reminder into a failed job.
 */
import { logger } from '../logger.js';
import { memoryService } from '../memory/memory-service.js';
import type { ArtifactMetadata } from '../types/execution.js';
import { notifyWebSession } from './web-notifications.js';

/**
 * A task added with `--alert` rings phones with the items its reply lists.
 * Best effort like the reminder: looked up after the reply is stored, and a
 * failure only loses the alert.
 */
async function alertIfAsked(
  source: string,
  sessionId: string,
  agentId: string,
  text: string,
  messageId: number,
): Promise<void> {
  const taskId = /^schedule:(\d+)$/.exec(source)?.[1];
  if (!taskId) return;
  const [{ getJob }, { displayNameForAgent }, { alertListedItems }] =
    await Promise.all([
      import('../memory/jobs.js'),
      import('../agents/agent-registry.js'),
      import('./mobile-push.js'),
    ]);
  const alert = getJob(Number(taskId), { kind: 'scheduled_task' })?.alert;
  if (!alert) return;
  await alertListedItems({
    sessionId,
    kind: alert,
    assistant: displayNameForAgent(agentId),
    text,
    messageId,
  });
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
  notifyWebSession(session.id, 'reminder', String(messageId));
  void alertIfAsked(
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
