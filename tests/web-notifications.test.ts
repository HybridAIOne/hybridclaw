import { createECDH } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), storeMessage: vi.fn(), getSession: vi.fn(),
  readSecrets: vi.fn(), saveSecrets: vi.fn(), warn: vi.fn(),
}));
vi.mock('../src/security/public-https-fetch.js', () => ({ fetchPublicHttpsBuffer: mocks.fetch }));
vi.mock('../src/security/runtime-secrets.js', () => ({ readStoredRuntimeSecrets: mocks.readSecrets, saveNamedRuntimeSecrets: mocks.saveSecrets }));
vi.mock('../src/memory/memory-service.js', () => ({ memoryService: { storeMessage: mocks.storeMessage, getSessionById: mocks.getSession } }));
vi.mock('../src/logger.js', () => ({ logger: { warn: mocks.warn } }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));

const tempDir = useTempDir();
useCleanMocks({ resetModules: true, unstubAllEnvs: true });
let directory: string;
beforeEach(() => {
  directory = tempDir();
  vi.doMock('../src/config/config.js', () => ({ DATA_DIR: directory, getConfigSnapshot: () => ({ deployment: { a2a_local_mode: false } }) }));
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue({ body: Buffer.alloc(0) });
  mocks.readSecrets.mockReturnValue({});
  mocks.getSession.mockReturnValue({ id: 'session-a', channel_id: 'web', agent_id: 'agent-a' });
  mocks.storeMessage.mockReturnValue(42);
});

function subscription(endpoint = 'https://push.example.com/send/browser-a') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
}

function storedSubscriptions(operatorId: string) {
  const data = JSON.parse(fs.readFileSync(`${directory}/web-notifications.json`, 'utf8'));
  return Object.values(data.operators[operatorId]?.subscriptions ?? {});
}

async function modules() {
  const store = await import('../src/gateway/web-notification-store.js');
  const notifications = await import('../src/gateway/web-notifications.js');
  const operator = store.notificationOperatorId('user-a');
  store.bindWebNotificationSession('session-a', operator);
  return { store, notifications, operator };
}

describe('web notification durability and isolation', () => {
  test('persists unread alerts, immutable session ownership and browser ownership across reloads', async () => {
    const { store, notifications, operator } = await modules();
    const other = store.notificationOperatorId('user-b');
    store.bindWebNotificationSession('session-a', other);
    notifications.notifyWebSession('session-a', 'turn', '42');
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(1);
    expect(store.readWebNotificationState(other).notifications).toHaveLength(0);
    store.acknowledgeWebNotifications(other, ['session-a:turn:42']);
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(1);
    const sub = subscription();
    store.saveWebPushSubscription(operator, sub);
    store.deleteWebPushSubscription(other, sub.endpoint);
    expect(storedSubscriptions(operator)).toHaveLength(1);
    store.saveWebPushSubscription(other, sub);
    expect(storedSubscriptions(operator)).toHaveLength(0);
    expect(fs.statSync(`${directory}/web-notifications.json`).mode & 0o777).toBe(0o600);
    vi.resetModules();
    const reloaded = await import('../src/gateway/web-notification-store.js');
    expect(storedSubscriptions(other)).toEqual([sub]);
    expect(reloaded.readWebNotificationState(operator).notifications).toHaveLength(1);
  });

  test('records and broadcasts a completed turn with one store read and write', async () => {
    const { notifications, operator } = await modules();
    const reads = vi.spyOn(fs, 'readFileSync');
    const writes = vi.spyOn(fs, 'writeFileSync');
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    notifications.notifyWebChatResult(operator, { sessionId: 'session-a', channelId: 'web', guildId: null, userId: 'user-a', username: null, content: 'test' }, { status: 'success', result: 'reply', messageRole: 'assistant', toolsUsed: [], assistantMessageId: 9 });
    expect(reads.mock.calls.filter(([file]) => file === `${directory}/web-notifications.json`)).toHaveLength(1);
    expect(writes.mock.calls.filter(([file]) => String(file).startsWith(`${directory}/web-notifications.json.`))).toHaveLength(1);
    expect(mkdir).not.toHaveBeenCalled();
  });

  test('a failed commit publishes nothing and leaves ownership unchanged', async () => {
    const { notifications, store, operator } = await modules();
    const other = store.notificationOperatorId('user-b');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    notifications.notifyWebSession('session-a', 'turn', 'failed', other);
    rename.mockRestore();
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(0);
    expect(store.readWebNotificationState(other).notifications).toHaveLength(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
    notifications.notifyWebSession('session-a', 'turn', 'retry', other);
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(1);
    expect(store.readWebNotificationState(other).notifications).toHaveLength(0);
  });

  test('broadcasts only to the owning operator and cleans up disconnected streams', async () => {
    const { store, notifications, operator } = await modules();
    const { EventEmitter } = await import('node:events');
    const response = () => Object.assign(new EventEmitter(), { writeHead: vi.fn(), write: vi.fn(), destroyed: false, writableEnded: false });
    const a = response(); const b = response();
    notifications.streamWebNotifications(operator, a as unknown as ServerResponse);
    notifications.streamWebNotifications(store.notificationOperatorId('other'), b as unknown as ServerResponse);
    a.write.mockClear(); b.write.mockClear();
    notifications.notifyWebSession('session-a', 'reminder');
    expect(a.write).toHaveBeenCalledOnce();
    expect(b.write).not.toHaveBeenCalled();
    a.emit('close'); b.emit('close');
  });

  test('push uses encrypted payloads, respects preferences, prunes expired endpoints and never logs their secrets', async () => {
    const { store, notifications, operator } = await modules();
    store.saveWebPushSubscription(operator, subscription());
    notifications.notifyWebSession('session-a', 'turn', '1');
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    const options = mocks.fetch.mock.calls[0][1];
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toMatch(/^vapid /);
    expect(options.body).toBeInstanceOf(Buffer);
    expect(options.body.toString()).not.toContain('session-a');
    expect(mocks.saveSecrets).toHaveBeenCalledOnce();
    store.saveWebNotificationPreferences(operator, { turn: false, reminder: true, approval: true });
    notifications.notifyWebSession('session-a', 'turn', '2');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.fetch).toHaveBeenCalledOnce();
    mocks.fetch.mockRejectedValue(new Error('http_410'));
    notifications.notifyWebSession('session-a', 'reminder', '3');
    await vi.waitFor(() => expect(storedSubscriptions(operator)).toHaveLength(0));
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(3);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  test('does not notify errors, commands or hidden output', async () => {
    const { notifications, store, operator } = await modules();
    const request = { channelId: 'web', sessionId: 'session-a', content: 'test', userId: 'user-a', username: 'User', guildId: null };
    for (const result of [
      { status: 'error' as const, messageRole: 'assistant' as const },
      { status: 'success' as const, messageRole: 'command' as const },
      { status: 'success' as const, messageRole: 'assistant' as const, outputPresentation: { visible: false, segmentKind: 'final' as const, displaySurface: 'assistant_bubble' as const } },
    ]) notifications.notifyWebChatResult(operator, request, { result: null, toolsUsed: [], ...result });
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(0);
    notifications.notifyWebChatResult(operator, request, { status: 'success', result: 'private content', toolsUsed: [], messageRole: 'assistant', assistantMessageId: 7 });
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(1);
    expect(fs.readFileSync(`${directory}/web-notifications.json`, 'utf8')).not.toContain('private content');
  });

  test('approval alerts deduplicate and storage failure never fails a completed reply', async () => {
    const { notifications, store, operator } = await modules();
    notifications.notifyWebSession('session-a', 'approval', 'approval-a');
    notifications.notifyWebSession('session-a', 'approval', 'approval-a');
    expect(store.readWebNotificationState(operator).notifications).toMatchObject([{ kind: 'approval', sessionId: 'session-a' }]);
    fs.writeFileSync(`${directory}/web-notifications.json`, '{broken');
    expect(() => notifications.notifyWebChatResult(operator, { sessionId: 'session-a', channelId: 'web', guildId: null, userId: 'user-a', username: null, content: 'test' }, { status: 'success', result: 'reply', messageRole: 'assistant', toolsUsed: [] })).not.toThrow();
    expect(fs.readFileSync(`${directory}/web-notifications.json`, 'utf8')).toBe('{broken');
  });

  test('scheduled delivery reuses persisted turns and saves system events before notifying', async () => {
    const { store, operator } = await modules();
    const { deliverWebScheduledMessage } = await import('../src/gateway/web-scheduled-delivery.js');
    deliverWebScheduledMessage('session-a', 'reminder', 'schedule:1', undefined, { sessionId: 'session-a', id: 8 });
    expect(mocks.storeMessage).not.toHaveBeenCalled();
    deliverWebScheduledMessage('session-a', 'system event', 'schedule-job:test');
    expect(mocks.storeMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a', content: 'system event' }));
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(2);
    mocks.getSession.mockReturnValue(undefined);
    expect(() => deliverWebScheduledMessage('missing', 'test', 'schedule:2')).toThrow();
    mocks.getSession.mockReturnValue({ id: 'session-a', channel_id: 'discord' });
    expect(() => deliverWebScheduledMessage('session-a', 'test', 'schedule:2')).toThrow();
  });
});

describe('push subscription boundary', () => {
  test('anonymous signed claims cannot inherit the local operator and token labels do not affect identity', async () => {
    const { resolveWebNotificationOperator } = await import('../src/gateway/web-notification-routes.js');
    expect(resolveWebNotificationOperator('session', null)).toBeNull();
    expect(resolveWebNotificationOperator('apiToken', 'label')).toBeNull();
    expect(resolveWebNotificationOperator('none', 'actor')).toBeNull();
    expect(resolveWebNotificationOperator('master', null)).toBe(resolveWebNotificationOperator('localSession', null));
    expect(resolveWebNotificationOperator('apiToken', 'label-a', 'token-a')).toBe(resolveWebNotificationOperator('apiToken', 'label-b', 'token-a'));
    expect(resolveWebNotificationOperator('session', 'user-a')).not.toBe(resolveWebNotificationOperator('session', 'user-b'));
    // The owner's phone is the operator the master token is, whichever token it holds.
    expect(resolveWebNotificationOperator('apiToken', 'label', 'token-a', true)).toBe(resolveWebNotificationOperator('master', null));
    expect(resolveWebNotificationOperator('session', 'user-a', undefined, true)).toBe(resolveWebNotificationOperator('session', 'user-a'));
    const { resolveAdminRbacAction, isAdminActionAllowed } = await import('../src/security/admin-rbac.js');
    const permission = resolveAdminRbacAction('/api/push/subscriptions', 'POST');
    expect(permission).toBe('chat.send');
    expect(isAdminActionAllowed({ actions: ['status.read'] }, permission!)).toBe(false);
  });
  test.each(['http://push.example.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://169.254.169.254/a', 'https://user:password@push.example.com/a', 'https://push.example.com:8080/a'])('rejects unsafe endpoint %s', async (endpoint) => {
    vi.stubEnv('BROWSER_ALLOW_PRIVATE_NETWORK', 'true');
    const { validateWebPushSubscription } = await import('../src/gateway/web-notification-routes.js');
    await expect(validateWebPushSubscription(subscription(endpoint))).rejects.toThrow();
  });

  test('validates browser keys and ignores a body-supplied operator', async () => {
    const { store, operator } = await modules();
    const { validateWebPushSubscription, handleWebNotificationRoute } = await import('../src/gateway/web-notification-routes.js');
    await expect(validateWebPushSubscription({ ...subscription(), keys: { p256dh: 'bad', auth: 'bad' } })).rejects.toThrow();
    const sub = subscription();
    const req = Object.assign(Readable.from([JSON.stringify({ ...sub, operatorId: 'attacker' })]), { method: 'POST' });
    const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    await handleWebNotificationRoute(req as IncomingMessage, res as unknown as ServerResponse, '/api/push/subscriptions', operator);
    expect(storedSubscriptions(operator)).toEqual([sub]);
    expect(storedSubscriptions('attacker')).toEqual([]);
  });
});
