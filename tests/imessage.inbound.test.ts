import { describe, expect, test } from 'vitest';
import {
  evaluateIMessageAccessPolicy,
  normalizeIMessageInbound,
} from '../src/channels/imessage/inbound.js';

const BASE_IMESSAGE_CONFIG = {
  enabled: true,
  backend: 'bluebubbles' as const,
  cliPath: 'imsg',
  dbPath: '/tmp/chat.db',
  pollIntervalMs: 2500,
  serverUrl: 'https://bb.example.com',
  password: 'secret',
  webhookPath: '/api/imessage/webhook',
  allowPrivateNetwork: false,
  dmPolicy: 'allowlist' as const,
  groupPolicy: 'disabled' as const,
  allowFrom: ['+14155551212'],
  groupAllowFrom: [],
  textChunkLimit: 4000,
  debounceMs: 2500,
  mediaMaxMb: 20,
};

describe('imessage inbound policy filtering', () => {
  test('blocks unauthorized direct messages in allowlist mode', () => {
    const result = evaluateIMessageAccessPolicy({
      dmPolicy: 'allowlist',
      groupPolicy: 'disabled',
      allowFrom: ['+14155551212'],
      groupAllowFrom: [],
      handle: '+14155550000',
      isGroup: false,
      isFromMe: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.isGroup).toBe(false);
  });

  test('allows explicit group allowlists when group mode is enabled', () => {
    const result = evaluateIMessageAccessPolicy({
      dmPolicy: 'allowlist',
      groupPolicy: 'allowlist',
      allowFrom: ['+14155550000'],
      groupAllowFrom: ['user@example.com'],
      handle: 'user@example.com',
      isGroup: true,
      isFromMe: false,
    });

    expect(result.allowed).toBe(true);
    expect(result.isGroup).toBe(true);
  });
});

test('normalizes direct iMessage inbound events into gateway session fields', () => {
  const result = normalizeIMessageInbound({
    config: BASE_IMESSAGE_CONFIG,
    backend: 'bluebubbles',
    conversationId: 'any;-;+14155551212',
    senderHandle: '+1 (415) 555-1212',
    text: 'hello there',
    isGroup: false,
    isFromMe: false,
    displayName: 'Alice',
    messageId: 'msg-1',
    rawEvent: { example: true },
  });

  expect(result).toMatchObject({
    channelId: 'imessage:+14155551212',
    userId: '+14155551212',
    username: 'Alice',
    messageId: 'msg-1',
    backend: 'bluebubbles',
  });
  expect(result?.sessionId).toContain('channel:imessage:chat:dm');
});

test('normalizes group iMessage inbound events into chat-scoped channels', () => {
  const result = normalizeIMessageInbound({
    config: {
      ...BASE_IMESSAGE_CONFIG,
      groupPolicy: 'open',
    },
    backend: 'bluebubbles',
    conversationId: 'any;+;chat123',
    senderHandle: 'user@example.com',
    text: 'group ping',
    isGroup: true,
    isFromMe: false,
    displayName: 'Project Chat',
    messageId: 'msg-2',
    rawEvent: { example: true },
  });

  expect(result).toMatchObject({
    channelId: 'imessage:chat:any;+;chat123',
    isGroup: true,
    userId: 'user@example.com',
  });
});
