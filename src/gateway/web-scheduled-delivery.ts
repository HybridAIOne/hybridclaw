/**
 * Scheduled web output is delivered to its originating conversation at run time.
 * Unlike transport queues, durable history is the delivery target; push is only
 * a best-effort alert and cannot turn a stored reminder into a failed job.
 */
import { memoryService } from '../memory/memory-service.js';
import type { ArtifactMetadata } from '../types/execution.js';
import { notifyWebSession } from './web-notifications.js';

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
  return { status: 'delivered' };
}
