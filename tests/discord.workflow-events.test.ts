import { afterEach, expect, test, vi } from 'vitest';

const { publishWorkflowEventMock } = vi.hoisted(() => ({
  publishWorkflowEventMock: vi.fn(async () => []),
}));

vi.mock('../src/workflow/event-bus.js', () => ({
  publishWorkflowEvent: publishWorkflowEventMock,
}));

afterEach(() => {
  publishWorkflowEventMock.mockClear();
});

test('publishes Discord reaction workflow events with normalized payloads', async () => {
  const { publishDiscordReactionWorkflowEvent } = await import(
    '../src/channels/discord/workflow-events.ts'
  );

  await publishDiscordReactionWorkflowEvent({
    channelId: 'discord-channel-1',
    senderId: 'user-1',
    reactionEmoji: '  fire  ',
    content: '  hello world  ',
    timestamp: 12345,
  });

  expect(publishWorkflowEventMock).toHaveBeenCalledWith({
    kind: 'reaction',
    sourceChannel: 'discord',
    channelId: 'discord-channel-1',
    senderId: 'user-1',
    content: 'hello world',
    reactionEmoji: 'fire',
    timestamp: 12345,
  });
});

test('skips publishing Discord reaction workflow events when the emoji is blank', async () => {
  const { publishDiscordReactionWorkflowEvent } = await import(
    '../src/channels/discord/workflow-events.ts'
  );

  const result = await publishDiscordReactionWorkflowEvent({
    channelId: 'discord-channel-1',
    senderId: 'user-1',
    reactionEmoji: '   ',
  });

  expect(result).toEqual([]);
  expect(publishWorkflowEventMock).not.toHaveBeenCalled();
});
