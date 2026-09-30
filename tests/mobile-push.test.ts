import fs from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  apiKey: vi.fn(), getSession: vi.fn(), warn: vi.fn(), webPush: vi.fn(),
}));
vi.mock('../src/auth/hybridai-auth.js', () => ({ readHybridAIApiKey: mocks.apiKey }));
vi.mock('../src/security/public-https-fetch.js', () => ({ fetchPublicHttpsBuffer: mocks.webPush }));
vi.mock('../src/memory/memory-service.js', () => ({ memoryService: { getSessionById: mocks.getSession } }));
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
    getConfigSnapshot: () => ({ deployment: { a2a_local_mode: false } }),
  }));
  vi.clearAllMocks();
  mocks.apiKey.mockReturnValue('hai-key');
  mocks.getSession.mockReturnValue({ id: 'session-a', agent_id: 'agent-a' });
  relay = vi.fn(async () => new Response(JSON.stringify({ status: 'sent' })));
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

function command(push: Awaited<ReturnType<typeof modules>>['push'], text: string, session = 'session-a') {
  return JSON.parse(push.runPushCommand(text.split(' '), session));
}

function relayed(call = 0) {
  const [url, init] = relay.mock.calls[call] as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
}

describe('/push command', () => {
  test('registers a phone for the operator that opened the session, and only from web chat', async () => {
    const { store, push, operator } = await modules();
    expect(command(push, `push register ${TOKEN.toUpperCase()} production proactive,approval`)).toEqual({ registered: true, relay: true });
    expect(store.readMobilePushDevices(operator)).toEqual([{ token: TOKEN, environment: 'production', kinds: ['proactive', 'approval'] }]);
    expect(command(push, 'push status')).toEqual({ devices: 1, relay: true });
    expect(command(push, `push register ${TOKEN} production`, 'discord-session')).toHaveProperty('error');
    expect(fs.statSync(`${directory}/web-notifications.json`).mode & 0o777).toBe(0o600);
    expect(command(push, `push unregister ${TOKEN}`)).toEqual({ registered: false });
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });

  test('a phone moves when another operator registers it; browsers kinds are the default', async () => {
    const { store, push, operator } = await modules();
    const other = store.notificationOperatorId('apiToken:token-b');
    store.bindWebNotificationSession('session-b', other);
    command(push, `push register ${TOKEN} sandbox`);
    command(push, `push register ${TOKEN} sandbox`, 'session-b');
    expect(store.readMobilePushDevices(operator)).toEqual([]);
    expect(store.readMobilePushDevices(other)).toEqual([{ token: TOKEN, environment: 'sandbox', kinds: ['turn', 'reminder', 'approval'] }]);
    // Unregistering from the first operator cannot drop the second one's phone.
    command(push, `push unregister ${TOKEN}`);
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
    expect(command(push, text)).toHaveProperty('error');
    expect(store.readMobilePushDevices(operator)).toEqual([]);
  });

  test('bounds phones per operator at 16', async () => {
    const { push } = await modules();
    for (let index = 0; index < 16; index += 1)
      expect(command(push, `push register ${index.toString(16).padStart(64, '0')} production`)).toHaveProperty('registered', true);
    expect(command(push, `push register ${TOKEN} production`)).toHaveProperty('error');
  });
});

describe('phone delivery', () => {
  test('gateway alerts reach phones that handle the kind, through the relay, without content', async () => {
    const { store, push, notifications, operator } = await modules();
    command(push, `push register ${TOKEN} production turn`);
    command(push, `push register ${OTHER_TOKEN} production proactive`);
    notifications.notifyWebChatResult(operator, { sessionId: 'session-a', channelId: 'web', guildId: null, userId: 'u', username: null, content: 'hi' }, { status: 'success', result: 'private reply', messageRole: 'assistant', toolsUsed: [], assistantMessageId: 9 });
    await vi.waitFor(() => expect(relay).toHaveBeenCalledOnce());
    const { url, headers, body } = relayed();
    expect(url).toBe('https://hybridai.example/v1/push');
    expect(headers.Authorization).toBe('Bearer hai-key');
    expect(body).toEqual({
      token: TOKEN,
      environment: 'production',
      payload: {
        aps: { alert: { title: 'HybridClaw finished your request' }, sound: 'default', 'thread-id': 'session-a' },
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
    expect(relay).toHaveBeenCalledOnce();
  });

  test('plugin alerts carry title, body, badge and data; a phone APNs no longer knows is forgotten', async () => {
    const { store, push, operator } = await modules();
    command(push, `push register ${TOKEN} production proactive`);
    command(push, `push register ${OTHER_TOKEN} sandbox proactive`);
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
    command(push, `push register ${TOKEN} production proactive`);
    mocks.apiKey.mockReturnValue(null);
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 0 });
    expect(relay).not.toHaveBeenCalled();
    mocks.apiKey.mockReturnValue('hai-key');
    relay.mockRejectedValue(new Error(`boom ${TOKEN}`));
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 0 });
    relay.mockResolvedValue(new Response('{"status":"failed"}', { status: 502 }));
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x' })).toEqual({ devices: 1, sent: 0 });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(TOKEN);
  });

  test('refuses reserved data keys, bad kinds and payloads APNs would refuse', async () => {
    const { push } = await modules();
    command(push, `push register ${TOKEN} production proactive`);
    await expect(push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x', data: { aps: 'x' } })).rejects.toThrow();
    await expect(push.notifySessionPhones('session-a', { kind: 'Proactive!', title: 'x' })).rejects.toThrow();
    await expect(push.notifySessionPhones('session-a', { kind: 'proactive', title: 'x', data: { blob: 'x'.repeat(5000) } })).rejects.toThrow();
    expect(push.buildApnsPayload({ kind: 'proactive', title: 't'.repeat(500) }).aps).toMatchObject({ alert: { title: `${'t'.repeat(119)}…` } });
    expect(relay).not.toHaveBeenCalled();
  });
});
