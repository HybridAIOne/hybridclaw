import { expect, test } from 'vitest';
import {
  buildIMessageChannelId,
  isIMessageGroupHandle,
  isIMessageHandle,
  normalizeIMessageHandle,
  parseIMessageChannelId,
  toBlueBubblesChatGuid,
} from '../src/channels/imessage/handle.js';

test('normalizes iMessage phone, email, and chat handles', () => {
  expect(normalizeIMessageHandle('+1 (415) 555-1212')).toBe('+14155551212');
  expect(normalizeIMessageHandle('User@Example.com')).toBe('user@example.com');
  expect(normalizeIMessageHandle('imessage:chat:any;+;chat123')).toBe(
    'chat:any;+;chat123',
  );
});

test('builds and parses internal iMessage channel ids', () => {
  const channelId = buildIMessageChannelId('+14155551212');

  expect(channelId).toBe('imessage:+14155551212');
  expect(parseIMessageChannelId(channelId)).toBe('+14155551212');
  expect(isIMessageHandle(channelId)).toBe(true);
});

test('converts direct and group handles into BlueBubbles chat guids', () => {
  expect(toBlueBubblesChatGuid('imessage:+14155551212')).toBe(
    'any;-;+14155551212',
  );
  expect(toBlueBubblesChatGuid('chat:any;+;chat123')).toBe('any;+;chat123');
  expect(isIMessageGroupHandle('chat:any;+;chat123')).toBe(true);
});
