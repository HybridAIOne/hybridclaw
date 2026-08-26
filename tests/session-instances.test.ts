import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-session-instances-',
});

const SESSION_KEY = 'agent:main:channel:msteams:chat:dm:peer:user-1';
const OTHER_SESSION_KEY = 'agent:main:channel:msteams:chat:dm:peer:user-2';

test('listSessionInstancesForKey returns the current instance first', async () => {
  setupHome();

  const {
    createFreshSessionInstance,
    getOrCreateSession,
    initDatabase,
    listSessionInstancesForKey,
  } = await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  const first = getOrCreateSession(SESSION_KEY, null, 'a:1');
  const rotated = createFreshSessionInstance(first.id);

  const instances = listSessionInstancesForKey(SESSION_KEY);
  expect(instances.map((instance) => instance.id)).toEqual([
    rotated.session.id,
    first.id,
  ]);
  expect(instances[0].is_current).toBe(1);
  expect(instances[1].is_current).toBe(0);
});

test('switchCurrentSessionInstance re-points the session key', async () => {
  setupHome();

  const {
    createFreshSessionInstance,
    getOrCreateSession,
    initDatabase,
    switchCurrentSessionInstance,
  } = await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  const first = getOrCreateSession(SESSION_KEY, null, 'a:1');
  const rotated = createFreshSessionInstance(first.id);
  expect(getOrCreateSession(SESSION_KEY, null, 'a:1').id).toBe(
    rotated.session.id,
  );

  const switched = switchCurrentSessionInstance({
    sessionKey: SESSION_KEY,
    targetSessionId: first.id,
  });
  expect(switched.previousSession?.id).toBe(rotated.session.id);
  expect(switched.session.id).toBe(first.id);
  expect(switched.session.is_current).toBe(1);
  expect(getOrCreateSession(SESSION_KEY, null, 'a:1').id).toBe(first.id);
});

test('switchCurrentSessionInstance is a no-op for the active instance', async () => {
  setupHome();

  const { getOrCreateSession, initDatabase, switchCurrentSessionInstance } =
    await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  const session = getOrCreateSession(SESSION_KEY, null, 'a:1');

  const switched = switchCurrentSessionInstance({
    sessionKey: SESSION_KEY,
    targetSessionId: session.id,
  });
  expect(switched.previousSession?.id).toBe(session.id);
  expect(switched.session.id).toBe(session.id);
});

test('switchCurrentSessionInstance rejects instances from other conversations', async () => {
  setupHome();

  const { getOrCreateSession, initDatabase, switchCurrentSessionInstance } =
    await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  getOrCreateSession(SESSION_KEY, null, 'a:1');
  const other = getOrCreateSession(OTHER_SESSION_KEY, null, 'a:2');

  expect(() =>
    switchCurrentSessionInstance({
      sessionKey: SESSION_KEY,
      targetSessionId: other.id,
    }),
  ).toThrow(/does not belong to this conversation/);
});
