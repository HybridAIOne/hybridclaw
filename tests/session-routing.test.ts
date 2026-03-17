import { expect, test } from 'vitest';

import { buildSessionKey } from '../src/session/session-key.js';
import {
  normalizeSessionIdentityLinks,
  resolveSessionRoutingScope,
} from '../src/session/session-routing.js';

test('resolveSessionRoutingScope keeps DMs isolated by default', () => {
  const specificKey = buildSessionKey('main', 'discord', 'dm', 'user-123');

  expect(
    resolveSessionRoutingScope(specificKey, {
      dmScope: 'per-channel-peer',
      identityLinks: {},
    }),
  ).toEqual({
    mainSessionKey: specificKey,
  });
});

test('resolveSessionRoutingScope collapses linked DM identities into a shared main key', () => {
  const specificKey = buildSessionKey('main', 'discord', 'dm', 'user-123');

  expect(
    resolveSessionRoutingScope(specificKey, {
      dmScope: 'per-linked-identity',
      identityLinks: normalizeSessionIdentityLinks({
        alice: ['discord:user-123', 'email:boss@example.com'],
      }),
    }),
  ).toEqual({
    mainSessionKey: buildSessionKey('main', 'main', 'dm', 'alice'),
    linkedIdentity: 'alice',
  });
});
