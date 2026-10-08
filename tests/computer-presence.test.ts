import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  apiKey: vi.fn(), getSession: vi.fn(), warn: vi.fn(), agent: vi.fn(), storeMessage: vi.fn(),
}));
vi.mock('../src/auth/hybridai-auth.js', () => ({ readHybridAIApiKey: mocks.apiKey }));
vi.mock('../src/security/public-https-fetch.js', () => ({ fetchPublicHttpsBuffer: vi.fn() }));
vi.mock('../src/memory/memory-service.js', () => ({ memoryService: { getSessionById: mocks.getSession, storeMessage: mocks.storeMessage } }));
vi.mock('../src/agents/agent-registry.js', () => ({ getAgentById: mocks.agent }));
vi.mock('../src/logger.js', () => ({ logger: { warn: mocks.warn } }));

const TOKEN = 'ab'.repeat(32);
const PAGE = 'page-0123456789';
const tempDir = useTempDir();
useCleanMocks({ resetModules: true, unstubAllGlobals: true });
let relay: ReturnType<typeof vi.fn>;
beforeEach(() => {
  const directory = tempDir();
  vi.doMock('../src/config/config.js', () => ({
    DATA_DIR: directory,
    HYBRIDAI_BASE_URL: 'https://hybridai.example/',
    getConfigSnapshot: () => ({ deployment: { a2a_local_mode: false } }),
  }));
  vi.clearAllMocks();
  mocks.apiKey.mockReturnValue('hai-key');
  mocks.getSession.mockReturnValue({ id: 'session-a', channel_id: 'web', agent_id: 'agent-a' });
  mocks.agent.mockReturnValue(null);
  mocks.storeMessage.mockReturnValue(7);
  relay = vi.fn(async (url: string) =>
    new Response(JSON.stringify({ status: url.endsWith('/devices') ? 'registered' : 'sent' })));
  vi.stubGlobal('fetch', relay);
});
afterEach(() => vi.useRealTimers());

async function modules() {
  const store = await import('../src/gateway/web-notification-store.js');
  const push = await import('../src/gateway/mobile-push.js');
  const notifications = await import('../src/gateway/web-notifications.js');
  const presence = await import('../src/gateway/computer-presence.js');
  const routes = await import('../src/gateway/web-notification-routes.js');
  const operator = store.notificationOperatorId('local-operator');
  store.bindWebNotificationSession('session-a', operator, 'hy');
  await push.runPushCommand(['push', 'register', TOKEN, 'production', 'turn,approval,reminder,proactive'], 'session-a');
  relay.mockClear();
  return { store, push, notifications, presence, routes, operator };
}

function alerts() {
  return relay.mock.calls
    .filter(([url]) => new URL(url as string).pathname === '/v1/push')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)).payload);
}

async function settled() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('phone stays quiet while the owner is at a computer', () => {
  test('a console login speaks for the owner; other identities only for themselves', async () => {
    const { routes, operator, store } = await modules();
    expect(routes.resolvePresenceOperator('session', store.notificationOperatorId('session:ben'))).toBe(operator);
    const token = store.notificationOperatorId('apiToken:paired');
    expect(routes.resolvePresenceOperator('apiToken', token)).toBe(token);
  });

  test('an alert waits while a page is in use and rings when the page goes away, if still unread', async () => {
    const { notifications, presence, store, operator } = await modules();
    presence.noteComputerPresence(operator, PAGE, true);
    notifications.notifyWebSession('session-a', 'turn', '1');
    notifications.notifyWebSession('session-a', 'approval', 'ab12');
    await settled();
    expect(alerts()).toHaveLength(0);
    // Recorded and broadcast as ever; only the ring waits.
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(2);

    // Read on the phone in the meantime: that one no longer rings.
    store.acknowledgeWebNotifications(operator, ['session-a:turn:1']);
    presence.noteComputerPresence(operator, PAGE, false);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0]).toMatchObject({ kind: 'approval', id: 'session-a:approval:ab12' });

    // Away: the next alert rings at once, and nothing rings twice.
    notifications.notifyWebSession('session-a', 'turn', '2');
    await vi.waitFor(() => expect(alerts()).toHaveLength(2));
    await settled();
    expect(alerts().map((alert) => alert.id)).toEqual(['session-a:approval:ab12', 'session-a:turn:2']);
  });

  test('a page that stops reporting counts as away; another open page keeps the phone quiet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { notifications, presence, operator } = await modules();
    presence.noteComputerPresence(operator, PAGE, true);
    vi.advanceTimersByTime(30_000);
    presence.noteComputerPresence(operator, 'page-second-tab', true);
    // The first tab is hidden; the second is still in use.
    presence.noteComputerPresence(operator, PAGE, false);
    notifications.notifyWebSession('session-a', 'reminder', '3');
    expect(presence.isAtComputer(operator)).toBe(true);
    vi.advanceTimersByTime(presence.PRESENCE_TTL_MS - 1);
    expect(alerts()).toHaveLength(0);
    // Lid shut: no more reports, so the gateway stops waiting.
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    expect(presence.isAtComputer(operator)).toBe(false);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
  });

  test('scheduled replies and plugin alerts wait too', async () => {
    const { push, presence, operator } = await modules();
    const delivery = await import('../src/gateway/web-scheduled-delivery.js');
    presence.noteComputerPresence(operator, PAGE, true);
    delivery.deliverWebScheduledMessage('session-a', 'Call Ben back', 'schedule:12:system');
    expect(await push.notifySessionPhones('session-a', { kind: 'proactive', title: 'Hy', body: 'New finds' })).toEqual({ devices: 1, sent: 0 });
    await settled();
    expect(alerts()).toHaveLength(0);
    presence.noteComputerPresence(operator, PAGE, false);
    await vi.waitFor(() => expect(alerts()).toHaveLength(2));
    expect(alerts().map((alert) => alert.aps.alert.body).sort()).toEqual(['Call Ben back', 'New finds']);
  });

  test('another operator at a computer does not quiet the owner’s phone', async () => {
    const { notifications, presence, store } = await modules();
    presence.noteComputerPresence(store.notificationOperatorId('apiToken:paired'), PAGE, true);
    notifications.notifyWebSession('session-a', 'turn', '4');
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
  });
});
