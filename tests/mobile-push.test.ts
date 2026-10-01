import fs from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  apiKey: vi.fn(), getSession: vi.fn(), warn: vi.fn(), webPush: vi.fn(), agent: vi.fn(), storeMessage: vi.fn(),
  localMode: { value: false },
}));
vi.mock('../src/auth/hybridai-auth.js', () => ({ readHybridAIApiKey: mocks.apiKey }));
vi.mock('../src/security/public-https-fetch.js', () => ({ fetchPublicHttpsBuffer: mocks.webPush }));
vi.mock('../src/memory/memory-service.js', () => ({ memoryService: { getSessionById: mocks.getSession, storeMessage: mocks.storeMessage } }));
vi.mock('../src/agents/agent-registry.js', () => ({ getAgentById: mocks.agent }));
vi.mock('../src/logger.js', () => ({ logger: { warn: mocks.warn } }));

const TOKEN = 'ab'.repeat(32);
const OTHER_TOKEN = 'cd'.repeat(32);
const tempDir = useTempDir();
useCleanMocks({ resetModules: true, unstubAllGlobals: true });
let directory: string;
let relay: ReturnType<typeof vi.fn>;
beforeEach(() => {
  directory = tempDir();
  vi.doMock('../src/config/config.js', () => ({
    DATA_DIR: directory,
    HYBRIDAI_BASE_URL: 'https://hybridai.example/',
    getConfigSnapshot: () => ({ deployment: { a2a_local_mode: mocks.localMode.value } }),
  }));
  vi.clearAllMocks();
  mocks.localMode.value = false;
  mocks.apiKey.mockReturnValue('hai-key');
  mocks.getSession.mockReturnValue({ id: 'session-a', channel_id: 'web', agent_id: 'agent-a' });
  mocks.agent.mockReturnValue(null);
  // HybridAI: binds phones, forwards alerts.
  relay = vi.fn(async (url: string) =>
    new Response(JSON.stringify({ status: url.endsWith('/devices') ? 'registered' : 'sent' })));
  vi.stubGlobal('fetch', relay);
});

async function modules() {
  const store = await import('../src/gateway/web-notification-store.js');
  const push = await import('../src/gateway/mobile-push.js');
  const notifications = await import('../src/gateway/web-notifications.js');
  const operator = store.notificationOperatorId('local-operator');
  store.bindWebNotificationSession('session-a', operator);
  return { store, push, notifications, operator };
}

async function command(push: Awaited<ReturnType<typeof modules>>['push'], text: string, session = 'session-a') {
  return JSON.parse(await push.runPushCommand(text.split(' '), session));
}

function calls(path = '/v1/push') {
  return relay.mock.calls.flatMap(([url, init]) => {
    const request = init as RequestInit;
    return new URL(url as string).pathname === path
      ? [{ url: url as string, method: request.method, headers: request.headers as Record<string, string>, body: JSON.parse(String(request.body)) }]
      : [];
  });
}

function relayed(call = 0) {
  return calls()[call];
}

describe('/push command', () => {
  test('registers a phone for the operator that opened the session, and only from web chat', async () => {
    const { store, push, operator } = await modules();
    expect(await command(push, `push register ${TOKEN.toUpperCase()} production proactive,approval`)).toEqual({ registered: true, relay: true });
    expect(store.readMobilePushDevices(operator)).toEqual([{ token: TOKEN, environment: 'production', kinds: ['proactive', 'approval'] }]);
    expect(await command(push, 'push status')).toEqual({ devices: 1, relay: true });
    expect(await command(push, `push register ${TOKEN} production`, 'discord-session')).toHaveProperty('error');
    expect(fs.statSync(`${directory}/web-notifications.json`).mode & 0o777).toBe(0o600);
    expect(await command(push, `push unregister ${TOKEN}`)).toEqual({ registered: false });
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });

  test('a phone moves when another operator registers it; browsers kinds are the default', async () => {
    const { store, push, operator } = await modules();
    const other = store.notificationOperatorId('apiToken:token-b');
    store.bindWebNotificationSession('session-b', other);
    await command(push, `push register ${TOKEN} sandbox`);
    await command(push, `push register ${TOKEN} sandbox`, 'session-b');
    expect(store.readMobilePushDevices(operator)).toEqual([]);
    expect(store.readMobilePushDevices(other)).toEqual([{ token: TOKEN, environment: 'sandbox', kinds: ['turn', 'reminder', 'approval'] }]);
    // Unregistering from the first operator cannot drop the second one's phone.
    await command(push, `push unregister ${TOKEN}`);
    expect(store.readMobilePushDevices(other)).toHaveLength(1);
  });

  test.each([
    'push register nothex production',
    `push register ${TOKEN} staging`,
    `push register ${TOKEN} production Bad-Kind`,
    `push register ${TOKEN} production a,b,c,d,e,f,g,h,i`,
    'push',
  ])('refuses %s', async (text) => {
    const { store, push, operator } = await modules();
    expect(await command(push, text)).toHaveProperty('error');
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });

  test('bounds phones per operator at 16', async () => {
    const { push } = await modules();
    for (let index = 0; index < 16; index += 1)
      expect(await command(push, `push register ${index.toString(16).padStart(64, '0')} production`)).toHaveProperty('registered', true);
    expect(await command(push, `push register ${TOKEN} production`)).toHaveProperty('error');
  });
});

describe('phone delivery', () => {
  test('gateway alerts reach phones that handle the kind, through the relay, without content', async () => {
    const { store, push, notifications, operator } = await modules();
    await command(push, `push register ${TOKEN} production turn`);
    await command(push, `push register ${OTHER_TOKEN} production proactive`);
    notifications.notifyWebChatResult(operator, { sessionId: 'session-a', channelId: 'web', guildId: null, userId: 'u', username: null, content: 'hi' }, { status: 'success', result: 'private reply', messageRole: 'assistant', toolsUsed: [], assistantMessageId: 9 });
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    const { url, headers, body } = relayed();
    expect(url).toBe('https://hybridai.example/v1/push');
    expect(headers.Authorization).toBe('Bearer hai-key');
    expect(body).toEqual({
      token: TOKEN,
      environment: 'production',
      payload: {
        aps: { alert: { title: 'HybridClaw', body: 'Done. Your reply is ready.', 'loc-key': 'Done. Your reply is ready.' }, sound: 'default', 'thread-id': 'session-a' },
        kind: 'turn',
        id: 'session-a:turn:9',
        sessionId: 'session-a',
        agentId: 'agent-a',
      },
    });
    expect(JSON.stringify(body)).not.toContain('private reply');
    store.saveWebNotificationPreferences(operator, { turn: false, reminder: true, approval: true });
    notifications.notifyWebSession('session-a', 'turn', '10');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls()).toHaveLength(1);
  });

  test('done and needs-you alerts name the assistant and say what happened in a line the app translates', async () => {
    const { push, notifications, operator } = await modules();
    mocks.agent.mockImplementation((id: string) => (id === 'agent-a' ? { id, name: 'Main Agent', displayName: 'Hy' } : null));
    await command(push, `push register ${TOKEN} production turn,approval`);
    notifications.notifyWebChatResult(operator, { sessionId: 'session-a', channelId: 'web', guildId: null, userId: 'u', username: null, content: 'send it' }, { status: 'success', result: 'I need your approval before I send the mail to Ben.', messageRole: 'assistant', toolsUsed: [], pendingApproval: { approvalId: 'ab12cd34' } } as never);
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    expect(relayed().body.payload).toEqual({
      aps: { alert: { title: 'Hy', body: 'Needs your approval to go on.', 'loc-key': 'Needs your approval to go on.' }, sound: 'default', 'thread-id': 'session-a' },
      kind: 'approval',
      id: 'session-a:approval:ab12cd34',
      sessionId: 'session-a',
      agentId: 'agent-a',
    });
    expect(JSON.stringify(relayed().body)).not.toContain('Ben');
    // Without a display name the agent's name, without an agent the product's.
    mocks.agent.mockReturnValue({ id: 'agent-a', name: 'Main Agent' });
    notifications.notifyWebSession('session-a', 'turn', '11');
    await vi.waitFor(() => expect(calls()).toHaveLength(2));
    expect(relayed(1).body.payload.aps.alert.title).toBe('Main Agent');
    // Other kinds keep the notice's own title.
    expect(push.replyAlert({ notification: { id: 'x', sessionId: 's', kind: 'reminder', agentId: null, title: 'HybridClaw reminder', createdAt: 0 }, assistant: 'Hy' }).title).toBe('HybridClaw reminder');
  });

  test('plugin alerts carry title, body, badge and data; a phone APNs no longer knows is forgotten', async () => {
    const { store, push, operator } = await modules();
    await command(push, `push register ${TOKEN} production proactive`);
    await command(push, `push register ${OTHER_TOKEN} sandbox proactive`);
    relay.mockImplementation(async (_url: string, init: RequestInit) =>
      new Response(JSON.stringify({ status: JSON.parse(String(init.body)).token === TOKEN ? 'sent' : 'unregistered' })));
    const result = await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'Ada', body: 'Reply to Ben', badge: 3, data: { id: '7f3c' } });
    expect(result).toEqual({ devices: 2, sent: 1 });
    expect(relayed().body.payload).toEqual({ aps: { alert: { title: 'Ada', body: 'Reply to Ben' }, sound: 'default', badge: 3 }, kind: 'proactive', id: '7f3c' });
    expect(store.readMobilePushDevices(operator).map((device) => device.token)).toEqual([TOKEN]);
    expect(await push.notifySessionPhones('session-a', { kind: 'turn', title: 'x' })).toEqual({ devices: 0, sent: 0 });
    expect(await push.notifySessionPhones('unknown-session', { kind: 'proactive', title: 'x' })).toEqual({ devices: 0, sent: 0 });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(TOKEN);
  });

  test('sends nothing without a HybridAI key, and a relay failure only counts as not sent', async () => {
    const { push } = await modules();
    await command(push, `push register ${TOKEN} production proactive`);
    mocks.apiKey.mockReturnValue(null);
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 0 });
    expect(calls()).toHaveLength(0);
    mocks.apiKey.mockReturnValue('hai-key');
    relay.mockRejectedValue(new Error(`boom ${TOKEN}`));
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 0 });
    relay.mockResolvedValue(new Response('{"status":"failed"}', { status: 502 }));
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 0 });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(TOKEN);
  });

  test('refuses reserved data keys, bad kinds and payloads APNs would refuse', async () => {
    const { push } = await modules();
    await command(push, `push register ${TOKEN} production proactive`);
    await expect(push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x', data: { aps: 'x' } })).rejects.toThrow();
    await expect(push.notifySessionPhones('session-a', { kind: 'Proactive!', title: 'x' })).rejects.toThrow();
    await expect(push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x', data: { blob: 'x'.repeat(5000) } })).rejects.toThrow();
    expect(push.buildApnsPayload({ kind: 'proactive', title: 't'.repeat(500) }).aps).toMatchObject({ alert: { title: `${'t'.repeat(119)}…` } });
    expect(calls()).toHaveLength(0);
  });

  test('a phone HybridAI does not know for this account is bound once and the alert retried once', async () => {
    const { store, push, operator } = await modules();
    // Registered while HybridAI was unreachable.
    relay.mockRejectedValueOnce(new Error('offline'));
    await command(push, `push register ${TOKEN} production proactive`);
    let bound = false;
    relay.mockImplementation(async (url: string) => {
      if (url.endsWith('/devices')) {
        bound = true;
        return new Response('{"status":"registered"}');
      }
      return new Response(JSON.stringify({ status: bound ? 'sent' : 'not_registered' }));
    });
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 1 });
    expect(relay.mock.calls.slice(1).map(([url]) => new URL(url as string).pathname)).toEqual(['/v1/push', '/v1/push/devices', '/v1/push']);

    // Bound to another account meanwhile: the phone is forgotten, not retried.
    relay.mockClear();
    relay.mockImplementation(async (url: string) =>
      url.endsWith('/devices')
        ? new Response('{"status":"taken"}', { status: 409 })
        : new Response('{"status":"not_registered"}'));
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 0 });
    expect(calls()).toHaveLength(1);
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });
});

describe('binding phones at HybridAI', () => {
  test('register binds the phone to the account first; unregister releases it', async () => {
    const { store, push, operator } = await modules();
    expect(await command(push, `push register ${TOKEN} sandbox`)).toEqual({ registered: true, relay: true });
    expect(calls('/v1/push/devices')).toEqual([{
      url: 'https://hybridai.example/v1/push/devices',
      method: 'POST',
      headers: { Authorization: 'Bearer hai-key', 'Content-Type': 'application/json' },
      body: { token: TOKEN, environment: 'sandbox' },
    }]);
    relay.mockResolvedValueOnce(new Response('{"status":"removed"}'));
    expect(await command(push, `push unregister ${TOKEN}`)).toEqual({ registered: false });
    expect(calls('/v1/push/devices')[1]).toMatchObject({ method: 'DELETE', body: { token: TOKEN } });
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });

  test('a phone bound to another account is refused and not kept', async () => {
    const { store, push, operator } = await modules();
    await command(push, `push register ${TOKEN} production`);
    relay.mockResolvedValue(new Response('{"status":"taken"}', { status: 409 }));
    expect(await command(push, `push register ${TOKEN} production`)).toEqual({
      registered: false,
      reason: 'taken',
      error: 'This phone gets alerts from another HybridAI account.',
    });
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });

  test('HybridAI unreachable: the phone is kept, and releasing it is best effort', async () => {
    const { store, push, operator } = await modules();
    relay.mockRejectedValue(new Error('offline'));
    expect(await command(push, `push register ${TOKEN} production`)).toEqual({ registered: true, relay: true });
    expect(store.readMobilePushDevices(operator)).toHaveLength(1);
    expect(await command(push, `push unregister ${TOKEN}`)).toEqual({ registered: false });
    expect(store.readMobilePushDevices(operator)).toEqual([]);
    relay.mockResolvedValue(new Response('bad gateway', { status: 502 }));
    expect(await command(push, `push register ${TOKEN} production`)).toEqual({ registered: true, relay: true });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(TOKEN);
  });

  test('the phone stays bound while another operator here still holds it', async () => {
    const { store, push } = await modules();
    const other = store.notificationOperatorId('apiToken:token-b');
    store.bindWebNotificationSession('session-b', other);
    await command(push, `push register ${TOKEN} sandbox`, 'session-b');
    await command(push, `push unregister ${TOKEN}`);
    expect(calls('/v1/push/devices').map((call) => call.method)).toEqual(['POST']);
  });

  test('nothing reaches HybridAI in A2A local mode', async () => {
    const { store, push, operator } = await modules();
    mocks.localMode.value = true;
    expect(await command(push, `push register ${TOKEN} production proactive`)).toEqual({ registered: true, relay: true });
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 0 });
    await command(push, `push unregister ${TOKEN}`);
    expect(store.readMobilePushDevices(operator)).toEqual([]);
    expect(relay).not.toHaveBeenCalled();
  });
});

describe('reminder alerts', () => {
  async function remind(delivery: typeof import('../src/gateway/web-scheduled-delivery.js'), text: string, id: number) {
    mocks.storeMessage.mockReturnValueOnce(id);
    delivery.deliverWebScheduledMessage('session-a', text, 'schedule:12:system');
    await vi.waitFor(() => expect(calls().length).toBeGreaterThan(0));
    const payload = calls().at(-1)?.body.payload;
    relay.mockClear();
    return payload;
  }

  test('say who reminds and what, badge the unread reminders, and name the stored reply', async () => {
    const { store, push, notifications, operator } = await modules();
    const delivery = await import('../src/gateway/web-scheduled-delivery.js');
    await command(push, `push register ${TOKEN} production reminder`);
    mocks.agent.mockReturnValue({ id: 'agent-a', name: 'Main Agent', displayName: 'Hy' });
    expect(await remind(delivery, 'huhu', 152734)).toEqual({
      aps: { alert: { title: 'Hy', body: 'huhu' }, sound: 'default', badge: 1, 'thread-id': 'session-a' },
      kind: 'reminder',
      id: 'session-a:reminder:152734',
      sessionId: 'session-a',
      agentId: 'agent-a',
      messageId: 152734,
    });
    expect(mocks.agent).toHaveBeenCalledWith('agent-a');

    // Other kinds do not count; reading one reminder takes it off the badge.
    notifications.notifyWebSession('session-a', 'turn', '152735');
    mocks.agent.mockReturnValue({ id: 'agent-a', name: 'Main Agent' });
    expect((await remind(delivery, 'second', 152736)).aps).toMatchObject({ alert: { title: 'Main Agent' }, badge: 2 });
    store.acknowledgeWebNotifications(operator, ['session-a:reminder:152734']);
    mocks.agent.mockReturnValue(null);
    const third = await remind(delivery, `  ${'x'.repeat(300)}  `, 152737);
    expect(third.aps).toEqual({
      alert: { title: 'HybridClaw', body: `${'x'.repeat(239)}…` },
      sound: 'default',
      badge: 2,
      'thread-id': 'session-a',
    });
  });

  test('ring only phones that take reminders, while reminders are switched on', async () => {
    const { store, push, operator } = await modules();
    const delivery = await import('../src/gateway/web-scheduled-delivery.js');
    await command(push, `push register ${TOKEN} production turn`);
    relay.mockClear();
    mocks.storeMessage.mockReturnValue(5);
    delivery.deliverWebScheduledMessage('session-a', 'huhu', 'schedule:12:system');
    await command(push, `push register ${OTHER_TOKEN} production reminder`);
    store.saveWebNotificationPreferences(operator, { turn: true, reminder: false, approval: true });
    mocks.storeMessage.mockReturnValue(6);
    delivery.deliverWebScheduledMessage('session-a', 'huhu', 'schedule:12:system');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls()).toHaveLength(0);
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(2);
  });
});
