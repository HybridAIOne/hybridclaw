import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-proactive-web-',
});

function sseResponse() {
  const chunks: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => chunks.push(chunk) > 0),
    end: vi.fn(),
    destroyed: false,
    writableEnded: false,
  });
  return { res: res as unknown as ServerResponse, chunks };
}

test('a bare web target lands in the default agent main chat with a live notification', async () => {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const { deliverProactiveMessage } = await import(
    '../src/gateway/proactive-dispatch.ts'
  );
  const store = await import('../src/gateway/web-notification-store.ts');
  const { closeWebNotificationStreams, streamWebNotifications } = await import(
    '../src/gateway/web-notifications.ts'
  );
  db.initDatabase({ quiet: true });

  // Console chats and other agents' main chats are never guessed as targets.
  const consoleChat = db.getOrCreateSession('console-chat', null, 'web', 'main');
  const otherMain = db.getOrCreateSession(
    `main-${'cd'.repeat(16)}-writer`,
    null,
    'web',
    'writer',
  );
  const missing = await deliverProactiveMessage('web', 'Disk at 90%', 'heartbeat');
  expect(missing).toMatchObject({ status: 'failed' });
  expect(missing.reason).toContain('no main web chat');

  const main = db.getOrCreateSession(
    `main-${'ab'.repeat(16)}-main`,
    null,
    'web',
    'main',
  );
  const operator = store.notificationOperatorId('operator-a');
  store.bindWebNotificationSession(main.id, operator);
  const sse = sseResponse();
  streamWebNotifications(operator, sse.res);
  sse.chunks.length = 0;

  expect(
    await deliverProactiveMessage('web', 'Disk at 90%', 'heartbeat'),
  ).toMatchObject({ status: 'delivered' });
  expect(db.getRecentMessages(main.id)).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: 'Disk at 90%',
      source: 'heartbeat',
    }),
  ]);
  expect(db.getRecentMessages(consoleChat.id)).toEqual([]);
  expect(db.getRecentMessages(otherMain.id)).toEqual([]);
  expect(store.readWebNotificationState(operator).notifications).toEqual([
    expect.objectContaining({ sessionId: main.id, kind: 'reminder' }),
  ]);
  expect(sse.chunks.join('')).toContain(main.id);
  closeWebNotificationStreams();
});
