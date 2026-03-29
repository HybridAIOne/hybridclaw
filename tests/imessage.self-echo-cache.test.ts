import { describe, expect, test } from 'vitest';
import { createIMessageSelfEchoCache } from '../src/channels/imessage/self-echo-cache.js';

describe('iMessage self-echo cache', () => {
  test('matches exact outbound message ids', () => {
    const cache = createIMessageSelfEchoCache();
    cache.remember({
      channelId: 'imessage:+14155551212',
      messageId: 'local:123',
      text: 'hello',
    });

    expect(
      cache.has({
        channelId: 'imessage:+14155551212',
        messageId: 'local:123',
        text: 'hello',
      }),
    ).toBe(true);
  });

  test('does not treat id-backed text as a generic text fallback by default', () => {
    const cache = createIMessageSelfEchoCache();
    cache.remember({
      channelId: 'imessage:+14155551212',
      messageId: 'local:123',
      text: 'hello',
    });

    expect(
      cache.has({
        channelId: 'imessage:+14155551212',
        messageId: 'local:999',
        text: 'hello',
      }),
    ).toBe(false);
  });

  test('allows explicit text fallback for self-chat echoes', () => {
    const cache = createIMessageSelfEchoCache();
    cache.remember({
      channelId: 'imessage:+14155551212',
      messageId: 'local:123',
      text: 'hello',
    });

    expect(
      cache.has({
        channelId: 'imessage:+14155551212',
        messageId: 'local:999',
        text: 'hello',
        textMatchPolicy: 'any',
      }),
    ).toBe(true);
  });

  test('supports plain text-only echoes', () => {
    const cache = createIMessageSelfEchoCache();
    cache.remember({
      channelId: 'imessage:+14155551212',
      text: 'hello',
    });

    expect(
      cache.has({
        channelId: 'imessage:+14155551212',
        text: 'hello',
      }),
    ).toBe(true);
  });
});
