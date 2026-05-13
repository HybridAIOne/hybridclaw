import type {
  GatewayChatRequest,
  GatewayChatResult,
} from '../gateway/gateway-types.js';
import { logger } from '../logger.js';
import {
  emitRuntimeEvent,
  type RuntimeEventPayload,
} from '../skills/skill-run-events.js';
import type { Session } from '../types/session.js';

export interface PostTurnEvent extends RuntimeEventPayload {
  type: 'post_turn';
  session: Session;
  req: Pick<
    GatewayChatRequest,
    | 'source'
    | 'guildId'
    | 'userId'
    | 'username'
    | 'chatbotId'
    | 'model'
    | 'enableRag'
    | 'onProactiveMessage'
  >;
  channelType?: string | null;
  result: GatewayChatResult;
  runId: string;
  createdAt: string;
}

export type PostTurnSubscriber = (
  event: PostTurnEvent,
) => unknown | Promise<unknown>;

const postTurnSubscribers = new Set<PostTurnSubscriber>();

export function subscribePostTurnEvents(
  subscriber: PostTurnSubscriber,
): () => void {
  postTurnSubscribers.add(subscriber);
  return () => {
    postTurnSubscribers.delete(subscriber);
  };
}

export async function emitPostTurnEvent(event: PostTurnEvent): Promise<void> {
  emitRuntimeEvent(event);
  let subscriberIndex = 0;
  for (const subscriber of postTurnSubscribers) {
    subscriberIndex += 1;
    try {
      await subscriber(event);
    } catch (error) {
      logger.warn(
        {
          runId: event.runId,
          sessionId: event.session.id,
          subscriberIndex,
          error,
        },
        'Post-turn subscriber failed',
      );
    }
  }
}
