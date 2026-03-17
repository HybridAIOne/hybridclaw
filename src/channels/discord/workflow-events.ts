import { publishWorkflowEvent } from '../../workflow/event-bus.js';

export async function publishDiscordReactionWorkflowEvent(params: {
  channelId: string;
  senderId: string;
  reactionEmoji: string;
  content?: string;
  timestamp?: number;
}): Promise<number[]> {
  const reactionEmoji = params.reactionEmoji.trim();
  if (!reactionEmoji) return [];

  return publishWorkflowEvent({
    kind: 'reaction',
    sourceChannel: 'discord',
    channelId: params.channelId,
    senderId: params.senderId,
    content: params.content?.trim() || undefined,
    reactionEmoji,
    timestamp:
      typeof params.timestamp === 'number' && Number.isFinite(params.timestamp)
        ? params.timestamp
        : Date.now(),
  });
}
