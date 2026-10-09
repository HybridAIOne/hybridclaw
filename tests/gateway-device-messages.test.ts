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
      source: 'schedule',
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

  test('a stored reply carries its receipt: what it read, sent and changed', async () => {
    const { memoryService, phone, other, get } = await setup();
    const { emitToolExecutionAuditEvents, recordAuditEvent } = await import(
      '../src/audit/audit-events.ts'
    );
    const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
    const id = memoryService.storeMessage({
      sessionId: 'ios-a',
      userId: 'user',
      username: null,
      role: 'assistant',
      content: 'Sent.',
    });
    emitToolExecutionAuditEvents({
      sessionId: 'ios-a',
      runId: 'turn-1',
      toolExecutions: [
        {
          name: 'hybridai__google__send_mail',
          arguments: JSON.stringify({
            to: 'pat@example.com',
            subject: 'Friday',
          }),
          result: 'Error: quota exceeded',
          durationMs: 5,
          isError: true,
          approvalTier: 'red',
          approvalDecision: 'approved_once',
          writeIntent: true,
        },
      ],
    });
    recordAuditEvent({
      sessionId: 'ios-a',
      runId: 'turn-1',
      event: {
        type: 'turn.end',
        turnIndex: 1,
        finishReason: 'completed',
        assistantMessageId: id,
      },
    });
    await flushAuditTrail();
    const sent = {
      version: 1,
      more: 0,
      items: [
        expect.objectContaining({
          kind: 'sent',
          target: 'Friday',
          to: ['@example.com'],
          ok: false,
          error: 'Error: quota exceeded',
        }),
      ],
    };
    expect(get(phone, `sessionId=ios-a&id=${id}`).body.receipt).toEqual(sent);
    expect(
      get(phone, `sessionId=ios-a&id=${id}&activityOffset=0`).body.receipt,
    ).toEqual(sent);
    expect(
      get(phone, `sessionId=ios-a&id=${id}&activityOffset=20`).body,
    ).not.toHaveProperty('receipt');
    expect(get(other, `sessionId=ios-a&id=${id}`).status).toBe(404);
  });

  test('trace pages are opt-in, ordered, bounded and owned by the session operator', async () => {
    const { memoryService, db, phone, other, get } = await setup();
    const id = memoryService.storeMessage({
      sessionId: 'ios-a',
      userId: 'user',
      username: null,
      role: 'assistant',
      content: 'Done',
    });
    db.setMessageActivityTrace(id, {
      steps: Array.from({ length: 23 }, (_, i) => ({
        kind: 'tool' as const,
        toolName: 'browser_click',
        status: 'done' as const,
        argsPreview: `step ${i}`,
        resultPreview: 'x'.repeat(9000),
        durationMs: 10,
      })),
      elapsedMs: 100,
    });
    expect(get(phone, `sessionId=ios-a&id=${id}`).body).not.toHaveProperty(
      'activity',
    );
    expect(get(other, `sessionId=ios-a&id=${id}&activityOffset=0`).status).toBe(
      404,
    );
    const first = get(phone, `sessionId=ios-a&id=${id}&activityOffset=0`).body
      .activity;
    expect(first).toMatchObject({
      version: 1,
      offset: 0,
      total: 23,
      nextOffset: 20,
      elapsedMs: 100,
    });
    expect(first.steps).toHaveLength(20);
    expect(first.steps[0]).toMatchObject({
      index: 0,
      status: 'recorded',
      truncated: true,
    });
    expect(first.steps[0].resultPreview).toHaveLength(8000);
    const last = get(phone, `sessionId=ios-a&id=${id}&activityOffset=20`).body
      .activity;
    expect(last.steps.map((s: { index: number }) => s.index)).toEqual([
      20, 21, 22,
    ]);
    expect(last.nextOffset).toBeNull();
    for (const offset of ['-1', '1.2', '01', '10000000', '']) {
      expect(
        get(phone, `sessionId=ios-a&id=${id}&activityOffset=${offset}`).status,
      ).toBe(400);
    }
  });

  test('an absent trace stays empty and credential redaction cannot be disabled for phone details', async () => {
    const { memoryService, db, phone, get } = await setup();
    const id = memoryService.storeMessage({
      sessionId: 'ios-a',
      userId: 'user',
      username: null,
      role: 'assistant',
      content: 'Done',
    });
    expect(
      get(phone, `sessionId=ios-a&id=${id}&activityOffset=0`).body.activity
        .steps,
    ).toEqual([]);
    vi.stubEnv('HYBRIDCLAW_REDACT_SECRETS', 'false');
    try {
      db.setMessageActivityTrace(id, {
        steps: [
          { kind: 'thinking', text: 'Authorization: Bearer test-secret-value' },
          { kind: 'draft', text: 'Checking the page.' },
          {
            kind: 'tool',
            toolName: 'browser_click',
            status: 'done',
            argsPreview: 'https://example.com?access_token=test-secret-value',
          },
        ],
      });
      const page = get(phone, `sessionId=ios-a&id=${id}&activityOffset=0`).body
        .activity;
      expect(page.steps.map((s: { kind: string }) => s.kind)).toEqual([
        'thinking',
        'draft',
        'tool',
      ]);
      expect(JSON.stringify(page)).not.toContain('test-secret-value');
    } finally {
      vi.unstubAllEnvs();
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
