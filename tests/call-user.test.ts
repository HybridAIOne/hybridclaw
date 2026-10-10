import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  apiKey: vi.fn(),
  getSession: vi.fn(),
  agent: vi.fn(),
  activeHours: vi.fn(),
  timezone: vi.fn(),
  work: vi.fn(),
  mainChat: vi.fn(),
}));
vi.mock('../src/auth/hybridai-auth.js', () => ({ readHybridAIApiKey: mocks.apiKey }));
vi.mock('../src/memory/sessions.js', () => ({ getSessionById: mocks.getSession }));
vi.mock('../src/agents/agent-registry.js', () => ({ getAgentById: mocks.agent }));
vi.mock('../src/agent/proactive-policy.js', () => ({ isWithinCallHours: mocks.activeHours }));
vi.mock('../src/work/work-tool.js', () => ({ currentWork: mocks.work }));
vi.mock('../src/gateway/web-scheduled-delivery.js', () => ({ mainChatForWebTask: mocks.mainChat }));
vi.mock('../src/workspace.js', () => ({ readUserTimezone: mocks.timezone }));
vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

const VOIP = 'ab'.repeat(32);
const ALERT = 'cd'.repeat(32);
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
  mocks.getSession.mockImplementation((id: string) => (id.startsWith('session-') ? { id, agent_id: 'hy' } : undefined));
  mocks.agent.mockReturnValue({ id: 'hy', name: 'hy', displayName: 'Hy' });
  mocks.activeHours.mockReturnValue(true);
  mocks.timezone.mockReturnValue('Europe/Berlin');
  mocks.work.mockReturnValue(null);
  mocks.mainChat.mockReturnValue(null);
  relay = vi.fn(async (url: string) =>
    new Response(JSON.stringify({ status: url.endsWith('/devices') ? 'registered' : 'sent' })));
  vi.stubGlobal('fetch', relay);
});

afterEach(() => {
  vi.useRealTimers();
});

async function modules(options: { voip?: boolean } = { voip: true }) {
  const store = await import('../src/gateway/web-notification-store.js');
  const push = await import('../src/gateway/mobile-push.js');
  const calls = await import('../src/gateway/phone-calls.js');
  const tool = await import('../src/gateway/call-user.js');
  calls.resetPhoneCallsForTests();
  const operator = store.notificationOperatorId('owner');
  store.bindWebNotificationSession('session-a', operator, 'hy');
  await push.runPushCommand(`push register ${ALERT} production turn`.split(' '), 'session-a');
  if (options.voip)
    await push.runPushCommand(`push register ${VOIP} production call hy ios voip`.split(' '), 'session-a');
  relay.mockClear();
  return { store, push, calls, tool, operator };
}

function pushes() {
  return relay.mock.calls
    .filter(([url]) => new URL(url as string).pathname === '/v1/push')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

async function ringing(): Promise<string> {
  await vi.waitFor(() => expect(pushes()).toHaveLength(1));
  return pushes()[0].payload.callId;
}

function parsed(answer: { ok: true; result: string }) {
  return JSON.parse(answer.result) as { status: string; callId?: string; message: string };
}

function response() {
  const res = { status: 0, body: '', writeHead: (code: number) => { res.status = code; }, end: (body: string) => { res.body = body; } };
  return res;
}

describe('call_user', () => {
  test('rings, and the waiting tool learns the user picked up', async () => {
    const { tool, calls, operator } = await modules();
    const pending = tool.runCallUserTool({ reason: 'Your 7:00 brief', notes: 'Weather, then the 9:00 meeting', sessionId: 'session-a' });
    const callId = await ringing();
    expect(pushes()[0]).toMatchObject({ token: VOIP, push_type: 'voip', ttl_seconds: 40, payload: { kind: 'call', sessionId: 'session-a', agentId: 'hy', reason: 'Your 7:00 brief' } });
    // Another operator's stream cannot pick it up.
    expect(calls.answerPhoneCall(callId, 'someone-else')).toBeNull();
    expect(calls.answerPhoneCall(callId, operator)).toMatchObject({ sessionId: 'session-a', notes: 'Weather, then the 9:00 meeting', state: 'answered' });
    const answer = parsed(await pending);
    expect(answer).toMatchObject({ status: 'answered', callId });
    expect(answer.message).toContain('End your turn with one short line');

    // While the call is live, another one is refused without ringing.
    relay.mockClear();
    expect(parsed(await tool.runCallUserTool({ reason: 'More', sessionId: 'session-a' })).status).toBe('busy');
    expect(pushes()).toEqual([]);
    calls.leavePhoneCall(callId);
    const next = tool.runCallUserTool({ reason: 'More', sessionId: 'session-a' });
    const nextId = await ringing();
    calls.answerPhoneCall(nextId, operator);
    expect(parsed(await next).status).toBe('answered');
  });

  test('without a phone that turned on calls, nothing rings', async () => {
    const { tool } = await modules({ voip: false });
    const answer = parsed(await tool.runCallUserTool({ reason: 'Hello', sessionId: 'session-a' }));
    expect(answer.status).toBe('not_allowed');
    expect(answer.message).toContain('Write your message in the chat');
    // A session nobody owns rings no one either.
    mocks.getSession.mockReturnValue({ id: 'other', agent_id: 'hy' });
    expect(parsed(await tool.runCallUserTool({ reason: 'Hello', sessionId: 'session-b' })).status).toBe('not_allowed');
    expect(pushes()).toEqual([]);
  });

  test('a scheduled run kept apart from its chat calls from the chat its reply goes to', async () => {
    const { tool, calls, operator, store } = await modules();
    // A `--reply-only` run: its own session, which no one owns.
    const runSession = 'session-cron-12';
    mocks.work.mockImplementation((id: string) => (id === runSession ? { sessionId: 'session-side' } : null));
    // Its replies go to the agent's main chat, which the phone app chats in.
    mocks.mainChat.mockImplementation((id: string) => (id === 'session-side' ? { id: 'session-a' } : null));
    const pending = tool.runCallUserTool({ reason: 'Your flight is delayed', sessionId: runSession });
    const callId = await ringing();
    expect(pushes()[0].payload).toMatchObject({ sessionId: 'session-a', agentId: 'hy' });
    expect(calls.answerPhoneCall(callId, operator)).toMatchObject({ sessionId: 'session-a' });
    expect(parsed(await pending).status).toBe('answered');
    expect(mocks.mainChat).toHaveBeenCalledWith('session-side');

    // Without a main chat it is the task's own chat; with no owner there, nothing rings.
    calls.resetPhoneCallsForTests();
    relay.mockClear();
    mocks.mainChat.mockReturnValue(null);
    expect(parsed(await tool.runCallUserTool({ reason: 'Hello', sessionId: runSession })).status).toBe('not_allowed');
    store.bindWebNotificationSession('session-side', operator, 'hy');
    const fromTaskChat = tool.runCallUserTool({ reason: 'Hello', sessionId: runSession });
    await ringing();
    expect(pushes()[0].payload.sessionId).toBe('session-side');
    calls.answerPhoneCall(pushes()[0].payload.callId, operator);
    expect(parsed(await fromTaskChat).status).toBe('answered');
    // A run that is no scheduled task's has no owner either.
    calls.resetPhoneCallsForTests();
    mocks.work.mockReturnValue(null);
    expect(parsed(await tool.runCallUserTool({ reason: 'Hello', sessionId: 'session-orphan' })).status).toBe('not_allowed');
  });

  test('outside active hours it rings only when the user asked for the call', async () => {
    const { tool, calls, operator } = await modules();
    mocks.activeHours.mockReturnValue(false);
    expect(parsed(await tool.runCallUserTool({ reason: 'News', sessionId: 'session-a' })).status).toBe('quiet_hours');
    expect(mocks.activeHours).toHaveBeenCalledWith(expect.any(Date), 'Europe/Berlin');
    expect(pushes()).toEqual([]);
    const pending = tool.runCallUserTool({ reason: 'Wake up', asked: true, sessionId: 'session-a' });
    calls.answerPhoneCall(await ringing(), operator);
    expect(parsed(await pending).status).toBe('answered');
  });

  test('declining from the phone needs the call to be the caller’s and ringing', async () => {
    const { tool, operator } = await modules();
    const pending = tool.runCallUserTool({ reason: 'Hello', sessionId: 'session-a' });
    const callId = await ringing();
    const path = `/api/chat/voice/calls/${callId}/decline`;
    const foreign = response();
    expect(tool.handleDeclineCallRoute(foreign as never, path, 'someone-else')).toBe(true);
    expect(foreign.status).toBe(404);
    const unknown = response();
    tool.handleDeclineCallRoute(unknown as never, `/api/chat/voice/calls/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/decline`, operator);
    expect(unknown.status).toBe(404);
    expect(tool.handleDeclineCallRoute(response() as never, '/api/chat/voice/token', operator)).toBe(false);
    const own = response();
    // An app may send the id in upper case.
    tool.handleDeclineCallRoute(own as never, `/api/chat/voice/calls/${callId.toUpperCase()}/decline`, operator);
    expect(own.status).toBe(200);
    expect(JSON.parse(own.body)).toEqual({ ok: true });
    const answer = parsed(await pending);
    expect(answer).toMatchObject({ status: 'declined', callId });
    expect(answer.message).toBe("The user didn't take the call. Write what you wanted to tell them in your reply now.");
    const again = response();
    tool.handleDeclineCallRoute(again as never, path, operator);
    expect(again.status).toBe(404);
  });

  test('a call nobody answers is missed after 40 s; three in an hour stop further calls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { tool, calls, operator } = await modules();
    for (let index = 0; index < 3; index += 1) {
      relay.mockClear();
      const pending = tool.runCallUserTool({ reason: `Try ${index}`, sessionId: 'session-a' });
      const callId = await ringing();
      expect(parsed(await tool.runCallUserTool({ reason: 'Again', sessionId: 'session-a' })).status).toBe('busy');
      await vi.advanceTimersByTimeAsync(40_000);
      expect(parsed(await pending)).toMatchObject({ status: 'missed', callId });
      // Too late to pick up.
      expect(calls.answerPhoneCall(callId, operator)).toBeNull();
    }
    relay.mockClear();
    expect(parsed(await tool.runCallUserTool({ reason: 'Fourth', sessionId: 'session-a' })).status).toBe('rate_limited');
    expect(pushes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const pending = tool.runCallUserTool({ reason: 'Later', sessionId: 'session-a' });
    calls.answerPhoneCall(await ringing(), operator);
    expect(parsed(await pending).status).toBe('answered');
  });

  test('a call no phone takes fails at once', async () => {
    const { tool } = await modules();
    relay.mockImplementation(async () => new Response('{"status":"failed"}', { status: 502 }));
    expect(parsed(await tool.runCallUserTool({ reason: 'Hello', sessionId: 'session-a' })).status).toBe('failed');
  });

  test.each([
    [{ sessionId: 'session-a' }, 400],
    [{ reason: 'x'.repeat(121), sessionId: 'session-a' }, 400],
    [{ reason: 'Hi', notes: 'x'.repeat(4001), sessionId: 'session-a' }, 400],
    [{ reason: 'Hi', opening: 42, sessionId: 'session-a' }, 400],
    [{ reason: 'Hi', sessionId: 'nope' }, 404],
  ])('refuses bad input %#', async (body, statusCode) => {
    const { tool } = await modules();
    await expect(tool.runCallUserTool(body)).rejects.toMatchObject({ statusCode });
    expect(pushes()).toEqual([]);
  });
});
