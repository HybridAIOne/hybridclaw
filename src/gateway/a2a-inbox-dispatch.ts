import type {
  A2AInboxDispatchHandler,
  A2AInboxDispatchHandlerResult,
} from '../a2a/a2a-inbox-dispatcher.js';
import { handleGatewayMessage } from './gateway-chat-service.js';

export const dispatchA2AInboxItemToGateway: A2AInboxDispatchHandler = async (
  invocation,
): Promise<A2AInboxDispatchHandlerResult> => {
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
