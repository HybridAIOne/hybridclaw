import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-notification-deletion-',
});

test('gateway session deletion removes notification ownership and unread alerts durably', async () => {
  setupHome();
  const { initDatabase, getOrCreateSession, storeMessage } = await import('../src/memory/db.js');
  const { deleteGatewayAdminSession } = await import('../src/gateway/gateway-service.js');
  const store = await import('../src/gateway/web-notification-store.js');
  const { DATA_DIR } = await import('../src/config/config.js');
  initDatabase({ quiet: true });
  const session = getOrCreateSession('notification-delete', null, 'web', 'main');
  const retained = getOrCreateSession('notification-retain', null, 'web', 'main');
  const operator = store.notificationOperatorId('user-a');
  for (const sessionId of [session.id, retained.id]) {
    store.recordWebNotification({ id: sessionId, sessionId, kind: 'turn', agentId: 'main', title: 'Finished', createdAt: 1 }, operator);
  }
  storeMessage(session.id, 'user-a', null, 'user', 'test');
  expect(deleteGatewayAdminSession(session.id, { onlyWithoutUserMessages: true }).deleted).toBe(false);
  expect(store.readWebNotificationState(operator).notifications).toHaveLength(2);
  expect(deleteGatewayAdminSession(session.id).deleted).toBe(true);
  expect(store.readWebNotificationState(operator).notifications.map((item) => item.sessionId)).toEqual([retained.id]);
  expect(store.recordWebNotification({ id: 'late', sessionId: session.id, kind: 'turn', agentId: 'main', title: 'Finished', createdAt: 2 })).toBeNull();
  expect(deleteGatewayAdminSession(session.id).deleted).toBe(false);
  const persisted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'web-notifications.json'), 'utf8'));
  expect(persisted.sessions).toEqual({ [store.notificationOperatorId(retained.id)]: operator });
});
