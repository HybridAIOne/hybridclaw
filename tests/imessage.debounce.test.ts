import { afterEach, expect, test, vi } from 'vitest';
import {
  createIMessageDebouncer,
  shouldDebounceIMessageInbound,
} from '../src/channels/imessage/debounce.js';

afterEach(() => {
  vi.useRealTimers();
});

function buildInbound(content: string) {
  return {
    sessionId:
      'agent:main:channel:imessage:chat:dm:peer:imessage%3A%2B14155551212',
    guildId: null,
    channelId: 'imessage:+14155551212',
    userId: '+14155551212',
    username: 'Alice',
    content,
    media: [],
    messageId: null,
    conversationId: 'any;-;+14155551212',
    handle: '+14155551212',
    isGroup: false,
    backend: 'bluebubbles' as const,
    rawEvent: { text: content },
    rawEvents: [{ text: content }],
  };
}

test('debounces rapid iMessage text into one merged batch', async () => {
  vi.useFakeTimers();
  const flushed: string[] = [];
  const debouncer = createIMessageDebouncer(async (item) => {
    flushed.push(item.content);
  });

  debouncer.enqueue(buildInbound('first'), 250);
  debouncer.enqueue(buildInbound('second'), 250);
  await vi.advanceTimersByTimeAsync(250);

  expect(flushed).toEqual(['first\nsecond']);
});

test('skips debouncing for slash-like control commands', () => {
  expect(
    shouldDebounceIMessageInbound({
      content: '/stop',
      hasMedia: false,
    }),
  ).toBe(false);
});
