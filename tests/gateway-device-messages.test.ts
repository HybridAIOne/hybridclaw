import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-device-messages-');

async function setup() {
  vi.resetModules();
  const directory = makeTempDir();
  vi.doMock('../src/config/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/config/config.js')>()),
    DATA_DIR: directory,
  }));
  const db = await import('../src/memory/db.ts');
  db.initDatabase({ quiet: true, dbPath: path.join(directory, 'db.sqlite') });
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const store = await import('../src/gateway/web-notification-store.ts');
  const route = await import('../src/gateway/device-messages.ts');
  const delivery = await import('../src/gateway/web-scheduled-delivery.ts');
  const phone = store.notificationOperatorId('apiToken:phone');
  const other = store.notificationOperatorId('apiToken:other');
  for (const id of ['ios-a', 'ios-b']) {
    memoryService.getOrCreateSession(id, null, 'web', 'main');
  }
  store.bindWebNotificationSession('ios-a', phone);
  store.bindWebNotificationSession('ios-b', other);
  const get = (operatorId: string, query: string) => {
    const res = fakeResponse();
    route.handleDeviceMessageRoute(
      res as unknown as ServerResponse,
      new URL(`http://127.0.0.1${route.DEVICE_MESSAGE_PATH}?${query}`),
      operatorId,
    );
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };
  return { db, memoryService, store, delivery, phone, other, get };
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    writeHead(status: number) {
      res.statusCode = status;
      return res;
    },
    end(chunk?: string) {
      res.body = chunk ?? '';
    },
  };
  return res;
}

describe('reading back a stored reply', () => {
  useCleanMocks({ resetModules: true, unmock: ['../src/config/config.js'] });

  test('a reminder reaches the chat owner through its notification', async () => {
    const { delivery, store, phone, get } = await setup();
    delivery.deliverWebScheduledMessage('ios-a', 'abendroutine', 'schedule', [
      { path: '/tmp/a.pdf', filename: 'a.pdf', mimeType: 'application/pdf' },
    ]);
    const [notification] = store.readWebNotificationState(phone).notifications;
    expect(notification.kind).toBe('reminder');
    const messageId = notification.id.split(':').at(-1);
    const { status, body } = get(phone, `sessionId=ios-a&id=${messageId}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: Number(messageId),
      sessionId: 'ios-a',
      agentId: 'main',
      content: 'abendroutine',
      artifacts: [
        { path: '/tmp/a.pdf', filename: 'a.pdf', mimeType: 'application/pdf' },
      ],
    });
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
    expect(body.createdAt.endsWith('Z')).toBe(true);
  });

  test('other operators, other sessions and user turns look like missing messages', async () => {
    const { memoryService, phone, other, get } = await setup();
    const reply = memoryService.storeMessage({
      sessionId: 'ios-a',
      userId: 'scheduler',
      username: 'HybridClaw',
      role: 'assistant',
      content: 'private',
    });
    const turn = memoryService.storeMessage({
      sessionId: 'ios-a',
      userId: 'hybridclaw-ios',
      username: null,
      role: 'user',
      content: 'what I typed',
    });
    const foreign = memoryService.storeMessage({
      sessionId: 'ios-b',
      userId: 'scheduler',
      username: 'HybridClaw',
      role: 'assistant',
      content: 'not yours',
    });
    memoryService.getOrCreateSession('unbound', null, 'web', 'main');
    const unbound = memoryService.storeMessage({
      sessionId: 'unbound',
      userId: 'scheduler',
      username: null,
      role: 'assistant',
      content: 'nobody chatted here',
    });
    expect(get(phone, `sessionId=ios-a&id=${reply}`).status).toBe(200);
    for (const [operator, query] of [
      [other, `sessionId=ios-a&id=${reply}`],
      [phone, `sessionId=ios-a&id=${turn}`],
      [phone, `sessionId=ios-a&id=${foreign}`],
      [phone, `sessionId=ios-b&id=${foreign}`],
      [phone, `sessionId=unbound&id=${unbound}`],
      [phone, `sessionId=ios-a&id=${reply + 1000}`],
    ] as const) {
      expect(get(operator, query)).toEqual({
        status: 404,
        body: { error: 'Message not found.' },
      });
    }
  });

  test('rejects malformed queries before touching storage', async () => {
    const { phone, get } = await setup();
    for (const query of [
      'id=1',
      'sessionId=ios-a',
      'sessionId=ios-a&id=0',
      'sessionId=ios-a&id=-1',
      'sessionId=ios-a&id=1.5',
      'sessionId=ios-a&id=1e3',
      `sessionId=${'x'.repeat(257)}&id=1`,
    ]) {
      expect(get(phone, query).status).toBe(400);
    }
  });

  test('a device token may call it with the scopes it is minted with', async () => {
    vi.resetModules();
    const rbac = await import('../src/security/admin-rbac.ts');
    const grants = await import('../src/gateway/device-grants.ts');
    const action = rbac.resolveAdminRbacAction('/api/chat/message', 'GET');
    expect(action).toBe('chat.send');
    expect(grants.DEVICE_TOKEN_ACTIONS).toContain(action);
    expect(rbac.resolveAdminRbacAction('/api/chat/message', 'POST')).toBeNull();
    // A call starts by minting its stream token.
    expect(grants.DEVICE_TOKEN_ACTIONS).toContain(
      rbac.resolveAdminRbacAction('/api/chat/voice/token', 'POST'),
    );
  });
});
