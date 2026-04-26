import { expect, test } from 'vitest';
import { processInboundSignalMessage } from '../src/channels/signal/inbound.js';
import type { RuntimeSignalConfig } from '../src/config/runtime-config.js';

function createSignalConfig(
  overrides: Partial<RuntimeSignalConfig> = {},
): RuntimeSignalConfig {
  return {
    enabled: true,
    daemonUrl: 'http://127.0.0.1:8080',
    account: '+491703330161',
    dmPolicy: 'allowlist',
    groupPolicy: 'disabled',
    allowFrom: ['+491703330161'],
    groupAllowFrom: [],
    textChunkLimit: 4_000,
    reconnectIntervalMs: 5_000,
    ...overrides,
  };
}

test('processes Signal Note-to-Self sync sent messages from the primary device', () => {
  const inbound = processInboundSignalMessage({
    config: createSignalConfig(),
    ownAccount: '+491703330161',
    envelope: {
      source: '+491703330161',
      sourceNumber: '+491703330161',
      sourceName: 'Benedikt Koehler',
      sourceDevice: 1,
      timestamp: 1_777_193_823_147,
      syncMessage: {
        sentMessage: {
          destinationNumber: '+491703330161',
          timestamp: 1_777_193_823_147,
          message: 'Hi!',
        },
      },
    },
  });

  expect(inbound).toMatchObject({
    guildId: null,
    channelId: 'signal:+491703330161',
    userId: '+491703330161',
    username: 'Benedikt Koehler',
    content: 'Hi!',
    isGroup: false,
  });
  expect(inbound?.sessionId).toContain('channel:signal:chat:dm');
});

test('drops Signal sync sent messages to other recipients', () => {
  const inbound = processInboundSignalMessage({
    config: createSignalConfig({
      allowFrom: ['+491703330161', '+491700000000'],
    }),
    ownAccount: '+491703330161',
    envelope: {
      source: '+491703330161',
      sourceNumber: '+491703330161',
      sourceName: 'Benedikt Koehler',
      sourceDevice: 1,
      timestamp: 1_777_193_823_147,
      syncMessage: {
        sentMessage: {
          destinationNumber: '+491700000000',
          timestamp: 1_777_193_823_147,
          message: 'Outbound echo',
        },
      },
    },
  });

  expect(inbound).toBeNull();
});

test('drops linked-device Signal sync echoes for Note-to-Self', () => {
  const inbound = processInboundSignalMessage({
    config: createSignalConfig(),
    ownAccount: '+491703330161',
    envelope: {
      source: '+491703330161',
      sourceNumber: '+491703330161',
      sourceName: 'Benedikt Koehler',
      sourceDevice: 2,
      timestamp: 1_777_193_823_147,
      syncMessage: {
        sentMessage: {
          destinationNumber: '+491703330161',
          timestamp: 1_777_193_823_147,
          message: 'Echo',
        },
      },
    },
  });

  expect(inbound).toBeNull();
});
