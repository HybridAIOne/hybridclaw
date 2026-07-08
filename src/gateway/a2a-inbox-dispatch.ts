import type {
  A2AInboxDispatchHandler,
  A2AInboxDispatchHandlerResult,
} from '../a2a/a2a-inbox-dispatcher.js';
import { logger } from '../logger.js';
import { memoryService } from '../memory/memory-service.js';
import { handleGatewayMessage } from './gateway-chat-service.js';

function storeA2AReplyInOriginThread(
  invocation: Parameters<A2AInboxDispatchHandler>[0],
): A2AInboxDispatchHandlerResult | null {
  const envelope = invocation.envelope;
  if (envelope.intent !== 'chat' || !envelope.parent_message_id) return null;

  const targetSession = memoryService.getSessionById(envelope.thread_id);
  if (!targetSession) {
    return {
      status: 'error',
      error: `A2A reply target session not found: ${envelope.thread_id}`,
    };
  }

  const content = envelope.content.trim();
  if (!content) {
    return {
      status: 'success',
      result: null,
    };
  }

  const messageId = memoryService.storeMessage({
    sessionId: targetSession.id,
    userId: envelope.sender_agent_id,
    username: envelope.sender_agent_id,
    role: 'assistant',
    content,
    agentId: envelope.sender_agent_id,
  });
  logger.info(
    {
      messageId,
      sessionId: targetSession.id,
      a2aMessageId: envelope.id,
      parentMessageId: envelope.parent_message_id,
      senderAgentId: envelope.sender_agent_id,
    },
    'Stored A2A reply in origin chat thread',
  );
  return {
    status: 'success',
    result: null,
  };
}

export const dispatchA2AInboxItemToGateway: A2AInboxDispatchHandler = async (
  invocation,
): Promise<A2AInboxDispatchHandlerResult> => {
  const storedReply = storeA2AReplyInOriginThread(invocation);
  if (storedReply) return storedReply;

  const result = await handleGatewayMessage({
    sessionId: invocation.sessionId,
    guildId: null,
    channelId: invocation.channelId,
    userId: invocation.userId,
    username: invocation.username,
    content: invocation.content,
    agentId: invocation.agentId,
    addressEnvelope: invocation.addressEnvelope,
    source: invocation.source,
  });

  if (result.status === 'error') {
    return {
      status: 'error',
      error: result.error || result.result || 'A2A recipient agent failed',
    };
  }

  return {
    status: 'success',
    result: result.result,
  };
};
