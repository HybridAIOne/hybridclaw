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
  store.bindWebNotificationSession('session-a', operator, 'hy');
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
    expect(await command(push, `push register ${TOKEN.toUpperCase()} production proactive,approval`)).toEqual({ registered: true, relay: true, app: 'hy' });
    expect(store.readMobilePushDevices(operator)).toEqual([{ token: TOKEN, environment: 'production', kinds: ['proactive', 'approval'], app: 'hy' }]);
    expect(await command(push, 'push status')).toEqual({ devices: 1, phones: [{ platform: 'ios', app: 'hy', kinds: ['proactive', 'approval'] }], relay: true });
    expect(await command(push, `push register ${TOKEN} production`, 'discord-session')).toHaveProperty('error');
    expect(fs.statSync(`${directory}/web-notifications.json`).mode & 0o777).toBe(0o600);
    expect(await command(push, `push unregister ${TOKEN}`)).toEqual({ registered: false });
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });

  test('a phone moves when another operator registers it; browsers kinds are the default', async () => {
    const { store, push, operator } = await modules();
    const other = store.notificationOperatorId('apiToken:token-b');
    store.bindWebNotificationSession('session-b', other, 'hy');
    await command(push, `push register ${TOKEN} sandbox`);
    await command(push, `push register ${TOKEN} sandbox`, 'session-b');
    expect(store.readMobilePushDevices(operator)).toEqual([]);
    expect(store.readMobilePushDevices(other)).toEqual([{ token: TOKEN, environment: 'sandbox', kinds: ['turn', 'reminder', 'approval'], app: 'hy' }]);
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

  test('preserves Firebase token case through registration, delivery and unregister', async () => {
    const { store, push, operator } = await modules();
    const token = `ExampleToken:${'A_b-9'.repeat(25)}`;
    expect(await command(push, `push register ${token} production reminder hy android`)).toMatchObject({ registered: true, platform: 'android' });
    expect(store.readMobilePushDevices(operator)[0]).toMatchObject({ token, platform: 'android' });
    expect(calls('/v1/push/devices')[0].body).toMatchObject({ token, platform: 'android' });
    await push.notifySessionPhones('session-a', { kind: 'reminder', title: 'Hy', body: 'Reminder' });
    expect(relayed().body).toMatchObject({ token, platform: 'android' });
    expect(await command(push, `push unregister ${token} android`)).toEqual({ registered: false });
    expect(store.readMobilePushDevices(operator)).toEqual([]);
    expect(calls('/v1/push/devices').at(-1)?.body).toEqual({ token, platform: 'android' });
  });

  test('Android registration rejects unsupported environments and apps before binding', async () => {
    const { push } = await modules();
    const token = `ExampleToken:${'Ab9'.repeat(40)}`;
    expect(await command(push, `push register ${token} sandbox reminder hy android`)).toHaveProperty('error');
    expect(await command(push, `push register ${token} production reminder salescompanion android`)).toHaveProperty('error');
    expect(await command(push, `push register ${token} production reminder hy unknown`)).toHaveProperty('error');
    expect(calls('/v1/push/devices')).toEqual([]);
  });

  test('a rejected registration cannot erase another operator’s local phone', async () => {
    const { store, push, operator } = await modules();
    await command(push, `push register ${TOKEN} production`);
    const other = store.notificationOperatorId('apiToken:other');
    store.bindWebNotificationSession('session-b', other, 'hy');
    relay.mockImplementation(async () => new Response(JSON.stringify({ status: 'taken' })));
    expect(await command(push, `push register ${TOKEN} production`, 'session-b')).toHaveProperty('registered', false);
    expect(store.readMobilePushDevices(operator)).toHaveLength(1);
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
        aps: { alert: { title: 'Hy', body: 'Done. Your reply is ready.', 'loc-key': 'Done. Your reply is ready.' }, sound: 'default', 'thread-id': 'session-a' },
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
    // The app calls the default agent Hy, whatever it is called here.
    mocks.getSession.mockReturnValue({ id: 'session-a', channel_id: 'web', agent_id: 'main' });
    mocks.agent.mockImplementation((id: string) => (id === 'main' ? { id, name: 'Main Agent', displayName: 'Jarvis' } : null));
    await command(push, `push register ${TOKEN} production turn,approval`);
    notifications.notifyWebChatResult(operator, { sessionId: 'session-a', channelId: 'web', guildId: null, userId: 'u', username: null, content: 'send it' }, { status: 'success', result: 'I need your approval before I send the mail to Ben.', messageRole: 'assistant', toolsUsed: [], pendingApproval: { approvalId: 'ab12cd34' } } as never);
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    expect(relayed().body.payload).toEqual({
      aps: { alert: { title: 'Hy', body: 'Waiting for your approval to go on.', 'loc-key': 'Waiting for your approval to go on.' }, sound: 'default', 'thread-id': 'session-a' },
      kind: 'approval',
      id: 'session-a:approval:ab12cd34',
      sessionId: 'session-a',
      agentId: 'main',
    });
    expect(JSON.stringify(relayed().body)).not.toContain('Ben');
    // A turn that ends asking for a website sign-in waits for the user too, without naming the site.
    notifications.notifyWebChatResult(operator, { sessionId: 'session-a', channelId: 'web', guildId: null, userId: 'u', username: null, content: 'book it' }, { status: 'success', result: 'Please sign in to example.com first.', messageRole: 'assistant', toolsUsed: [], assistantMessageId: 10 }, null, true);
    await vi.waitFor(() => expect(calls()).toHaveLength(2));
    expect(relayed(1).body.payload).toMatchObject({
      aps: { alert: { title: 'Hy', body: 'Waiting for you to sign in.', 'loc-key': 'Waiting for you to sign in.' } },
      kind: 'approval',
      id: 'session-a:approval:10',
    });
    expect(JSON.stringify(relayed(1).body)).not.toContain('example.com');
    relay.mockClear();
    // Another agent goes by its display name, then its name, and is Hy without either.
    mocks.getSession.mockReturnValue({ id: 'session-a', channel_id: 'web', agent_id: 'agent-a' });
    mocks.agent.mockReturnValue({ id: 'agent-a', name: 'Research', displayName: 'Ada' });
    notifications.notifyWebSession('session-a', 'turn', '11');
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    mocks.agent.mockReturnValue({ id: 'agent-a', name: 'Research' });
    notifications.notifyWebSession('session-a', 'turn', '12');
    await vi.waitFor(() => expect(calls()).toHaveLength(2));
    mocks.agent.mockReturnValue(null);
    notifications.notifyWebSession('session-a', 'turn', '13');
    await vi.waitFor(() => expect(calls()).toHaveLength(3));
    expect(calls().map((call) => call.body.payload.aps.alert.title)).toEqual(['Ada', 'Research', 'Hy']);
    expect(push.phoneAssistantName(null, null)).toBe('Hy');
    expect(push.phoneAssistantName('main', { name: 'Main Agent' })).toBe('Hy');
    // Other kinds show the name alone, never the notice's own title.
    const other = push.replyAlert({ notification: { id: 'x', sessionId: 's', kind: 'reminder', agentId: null, title: 'HybridClaw reminder', createdAt: 0 }, assistant: 'Hy' });
    expect(other).toMatchObject({ title: 'Hy' });
    expect(other).not.toHaveProperty('body');
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

  test('a phone rings only for chats its own app opened (#1781)', async () => {
    const { store, push, notifications, operator } = await modules();
    await command(push, `push register ${TOKEN} production turn,reminder,proactive`);
    // Same account, another app or a script: no client, so no Hy alert.
    store.bindWebNotificationSession('sales-companion', operator);
    const turn = (sessionId: string, id: number) =>
      notifications.notifyWebChatResult(operator, { sessionId, channelId: 'web', guildId: null, userId: 'u', username: null, content: 'hi' }, { status: 'success', result: 'reply', messageRole: 'assistant', toolsUsed: [], assistantMessageId: id });
    turn('sales-companion', 1);
    expect(await push.notifySessionPhones('sales-companion', { kind: 'proactive', title: 'x' })).toEqual({ devices: 0, sent: 0 });
    expect(store.recordWebNotification({ id: 'r1', sessionId: 'sales-companion', kind: 'reminder', agentId: null, title: 'x', createdAt: 1 })?.devices).toEqual([]);
    turn('session-a', 2);
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    expect(relayed().body.payload.sessionId).toBe('session-a');

    // A chat last used from the browser stops ringing; from the app again, it rings.
    store.bindWebNotificationSession('session-a', operator);
    expect(store.readSessionMobilePushDevices('session-a')).toEqual([]);
    store.bindWebNotificationSession('session-a', operator, 'hy');
    expect(store.readSessionMobilePushDevices('session-a')).toHaveLength(1);
    // Another operator cannot change the app of a chat it does not own.
    store.bindWebNotificationSession('session-a', store.notificationOperatorId('apiToken:token-b'));
    expect(store.readSessionMobilePushDevices('session-a')).toHaveLength(1);
  });

  test('a phone registered for another app rings only for that app, signed for it; older phones are Hy', async () => {
    const { store, push, operator } = await modules();
    expect(await command(push, `push register ${OTHER_TOKEN} production proactive salescompanion`)).toEqual({ registered: true, relay: true, app: 'salescompanion' });
    expect(calls('/v1/push/devices')[0].body).toEqual({ token: OTHER_TOKEN, environment: 'production', app: 'salescompanion' });
    expect(await command(push, `push register ${TOKEN} production proactive Bad!`)).toHaveProperty('error');
    // Stored before phones named their app.
    const file = `${directory}/web-notifications.json`;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.operators[operator].devices[store.notificationOperatorId(TOKEN)] = { token: TOKEN, environment: 'production', kinds: ['proactive'] };
    fs.writeFileSync(file, JSON.stringify(saved));
    expect(store.readSessionMobilePushDevices('session-a').map((device) => device.token)).toEqual([TOKEN]);
    store.bindWebNotificationSession('session-c', operator, 'salescompanion');
    expect(await push.notifySessionPhones('session-c', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 1 });
    expect(relayed().body).toMatchObject({ token: OTHER_TOKEN, app: 'salescompanion' });
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 1 });
    expect(relayed(1).body).toMatchObject({ token: TOKEN });
    // Hy is the relay's default; relays that predate other apps refuse the field.
    expect(relayed(1).body).not.toHaveProperty('app');
    expect(await command(push, 'push status')).toMatchObject({ devices: 2, relay: true });
  });

  test('an app HybridAI does not sign for is refused and not kept', async () => {
    const { store, push, operator } = await modules();
    relay.mockResolvedValue(new Response('{"status":"unknown_app"}', { status: 400 }));
    expect(await command(push, `push register ${TOKEN} production turn nosuchapp`)).toEqual({
      registered: false,
      reason: 'unknown_app',
      error: 'HybridAI does not send alerts for this app.',
    });
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });

  test('a chat names its app with appId; the phone app without one is Hy', async () => {
    const { push } = await modules();
    expect(push.chatPushApp({ appId: 'salescompanion', client: 'mobile' })).toBe('salescompanion');
    expect(push.chatPushApp({ client: 'mobile' })).toBe('hy');
    expect(push.chatPushApp({})).toBeUndefined();
    expect(push.chatPushApp({ appId: 'Not An App' })).toBeUndefined();
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
    expect(await command(push, `push register ${TOKEN} sandbox`)).toEqual({ registered: true, relay: true, app: 'hy' });
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
    expect(await command(push, `push register ${TOKEN} production`)).toEqual({ registered: true, relay: true, app: 'hy' });
    expect(store.readMobilePushDevices(operator)).toHaveLength(1);
    expect(await command(push, `push unregister ${TOKEN}`)).toEqual({ registered: false });
    expect(store.readMobilePushDevices(operator)).toEqual([]);
    relay.mockResolvedValue(new Response('bad gateway', { status: 502 }));
    expect(await command(push, `push register ${TOKEN} production`)).toEqual({ registered: true, relay: true, app: 'hy' });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(TOKEN);
  });

  test('the phone stays bound while another operator here still holds it', async () => {
    const { store, push } = await modules();
    const other = store.notificationOperatorId('apiToken:token-b');
    store.bindWebNotificationSession('session-b', other, 'hy');
    await command(push, `push register ${TOKEN} sandbox`, 'session-b');
    await command(push, `push unregister ${TOKEN}`);
    expect(calls('/v1/push/devices').map((call) => call.method)).toEqual(['POST']);
  });

  test('nothing reaches HybridAI in A2A local mode', async () => {
    const { store, push, operator } = await modules();
    mocks.localMode.value = true;
    expect(await command(push, `push register ${TOKEN} production proactive`)).toEqual({ registered: true, relay: true, app: 'hy' });
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
    mocks.agent.mockReturnValue({ id: 'agent-a', name: 'Research', displayName: 'Ada' });
    expect(await remind(delivery, 'huhu', 152734)).toEqual({
      aps: { alert: { title: 'Ada', body: 'huhu' }, sound: 'default', badge: 1, 'thread-id': 'session-a' },
      kind: 'reminder',
      id: 'session-a:reminder:152734',
      sessionId: 'session-a',
      agentId: 'agent-a',
      messageId: 152734,
    });
    expect(mocks.agent).toHaveBeenCalledWith('agent-a');

    // Other kinds do not count; reading one reminder takes it off the badge.
    notifications.notifyWebSession('session-a', 'turn', '152735');
    mocks.agent.mockReturnValue({ id: 'agent-a', name: 'Research' });
    expect((await remind(delivery, 'second', 152736)).aps).toMatchObject({ alert: { title: 'Research' }, badge: 2 });
    store.acknowledgeWebNotifications(operator, ['session-a:reminder:152734']);
    mocks.agent.mockReturnValue(null);
    const third = await remind(delivery, `  ${'x'.repeat(300)}  `, 152737);
    expect(third.aps).toEqual({
      alert: { title: 'Hy', body: `${'x'.repeat(239)}…` },
      sound: 'default',
      badge: 2,
      'thread-id': 'session-a',
    });

    // The default agent is Hy on a phone, whatever it is called here.
    mocks.getSession.mockReturnValue({ id: 'session-a', channel_id: 'web', agent_id: 'main' });
    mocks.agent.mockReturnValue({ id: 'main', name: 'Main Agent', displayName: 'Jarvis' });
    expect(await remind(delivery, 'fourth', 152738)).toMatchObject({
      aps: { alert: { title: 'Hy', body: 'fourth' } },
      agentId: 'main',
    });
    expect(mocks.agent).toHaveBeenLastCalledWith('main');
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

describe('calls from Hy', () => {
  const FCM = `ExampleToken:${'Ab9'.repeat(40)}`;

  test('an iPhone registers its call (VoIP) token next to its alert token, for calls only', async () => {
    const { store, push, operator } = await modules();
    await command(push, `push register ${TOKEN} production turn`);
    expect(await command(push, `push register ${OTHER_TOKEN} sandbox call hy ios voip`)).toEqual({ registered: true, platform: 'ios', pushType: 'voip', relay: true, app: 'hy' });
    // The same token as alert and call token is two registrations.
    expect(await command(push, `push register ${TOKEN} production turn,reminder hy ios voip`)).toMatchObject({ pushType: 'voip' });
    expect(store.readMobilePushDevices(operator)).toEqual([
      { token: TOKEN, environment: 'production', kinds: ['turn'], app: 'hy' },
      { token: OTHER_TOKEN, environment: 'sandbox', app: 'hy', platform: 'ios', pushType: 'voip', kinds: ['call'] },
      { token: TOKEN, environment: 'production', app: 'hy', platform: 'ios', pushType: 'voip', kinds: ['call'] },
    ]);
    // Binding is unchanged: a call token is just another token.
    expect(calls('/v1/push/devices').at(-1)?.body).toEqual({ token: TOKEN, environment: 'production' });
    expect((await command(push, 'push status')).phones).toEqual([
      { platform: 'ios', app: 'hy', kinds: ['turn'] },
      { platform: 'ios', pushType: 'voip', app: 'hy', kinds: ['call'] },
      { platform: 'ios', pushType: 'voip', app: 'hy', kinds: ['call'] },
    ]);
    // Unregistering the call token keeps the alert token, and the other way round.
    expect(await command(push, `push unregister ${TOKEN} ios voip`)).toEqual({ registered: false });
    expect(store.readMobilePushDevices(operator).map((device) => [device.token, device.pushType])).toEqual([[TOKEN, undefined], [OTHER_TOKEN, 'voip']]);
    // The alert token is still held, so the relay keeps the binding.
    expect(calls('/v1/push/devices').filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(await command(push, `push unregister ${OTHER_TOKEN}`)).toEqual({ registered: false });
    expect(store.readMobilePushDevices(operator)).toHaveLength(2);
    expect(await command(push, `push unregister ${OTHER_TOKEN} ios voip`)).toEqual({ registered: false });
    expect(store.readMobilePushDevices(operator)).toHaveLength(1);
  });

  test.each([
    `push register ${FCM} production call hy android voip`,
    `push register ${TOKEN} production call hy ios pushkit`,
    `push unregister ${TOKEN} android voip`,
  ])('refuses %s', async (text) => {
    const { store, push, operator } = await modules();
    expect(await command(push, text)).toHaveProperty('error');
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });

  test('a call rings call tokens as VoIP and Android as an alert, silent, kept 40 s, and never at a computer', async () => {
    const { store, push } = await modules();
    await command(push, `push register ${TOKEN} production turn,reminder,approval`);
    await command(push, `push register ${OTHER_TOKEN} production call hy ios voip`);
    await command(push, `push register ${FCM} production turn,reminder,approval,call hy android`);
    relay.mockClear();
    const { devices } = store.readSessionCallDevices('session-a');
    expect(devices.map((device) => device.token)).toEqual([OTHER_TOKEN, FCM]);
    const expiresAt = Date.UTC(2026, 9, 10, 7, 0, 40);
    expect(await push.ringPhonesForCall(devices, { callId: 'call-1', sessionId: 'session-a', agentId: 'hy', assistant: 'Hy', reason: 'Your 7:00 brief', expiresAt })).toEqual({ devices: 2, sent: 2 });
    const payload = {
      aps: { alert: { title: 'Hy', body: 'Your 7:00 brief' } },
      kind: 'call',
      id: 'call:call-1',
      callId: 'call-1',
      sessionId: 'session-a',
      agentId: 'hy',
      reason: 'Your 7:00 brief',
      expiresAt: '2026-10-10T07:00:40.000Z',
    };
    expect(calls().map((call) => call.body)).toEqual([
      { token: OTHER_TOKEN, environment: 'production', push_type: 'voip', ttl_seconds: 40, payload },
      { token: FCM, environment: 'production', platform: 'android', ttl_seconds: 40, payload },
    ]);
    // Alerts never reach a call token, and carry neither new relay field.
    relay.mockClear();
    await push.notifySessionPhones('session-a', { kind: 'call', title: 'Hy' });
    await push.notifySessionPhones('session-a', { kind: 'turn', title: 'Hy' });
    expect(calls().map((call) => call.body.token)).toEqual([FCM, TOKEN, FCM]);
    for (const call of calls()) {
      expect(call.body).not.toHaveProperty('push_type');
      expect(call.body).not.toHaveProperty('ttl_seconds');
    }
  });
});
