import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, expect, test, vi } from 'vitest';
import { handleApiHistory } from '../src/gateway/history-route.js';

const mocks = vi.hoisted(() => ({
  getGatewayHistory: vi.fn(),
  ensureGatewayBootstrapAutostart: vi.fn(async () => undefined),
  getGatewayHistorySummary: vi.fn(() => ({})),
  getGatewayBootstrapAutostartState: vi.fn(() => null),
  getAgentById: vi.fn(() => undefined),
}));
vi.mock('../src/gateway/gateway-service.js', () => mocks);
vi.mock('../src/agents/agent-registry.js', () => ({ getAgentById: mocks.getAgentById }));
vi.mock('../src/gateway/chat-approval-review.js', () => ({ pendingChatApproval: () => null }));
vi.mock('../src/work/work-routes.js', () => ({ withWorkHistory: (_session: string, history: unknown) => history }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getGatewayHistory.mockReturnValue({
    sessionId: 'session-a', history: [], branchFamilies: [], nextCursor: '12',
  });
});

async function get(query: string, malformed = false) {
  const response = {
    statusCode: 0,
    body: '',
    writeHead(code: number) { this.statusCode = code; },
    end(body: string) { this.body = body; },
  };
  await handleApiHistory({} as IncomingMessage, response as unknown as ServerResponse,
    new URL(`http://localhost/api/history?${query}`), {
      isMalformedCanonicalSessionId: () => malformed,
      resolveGatewayRequestUserId: () => 'authenticated-user',
    });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

test('passes a validated exclusive cursor with the authenticated operator and returns the next cursor', async () => {
  const result = await get('sessionId=session-a&limit=80&before=42&userId=untrusted-user');
  expect(result).toMatchObject({ status: 200, body: { nextCursor: '12', history: [] } });
  expect(mocks.getGatewayHistory).toHaveBeenCalledWith('session-a', 80, {
    operatorUserId: 'authenticated-user', beforeMessageId: 42,
  });
  expect(mocks.ensureGatewayBootstrapAutostart).not.toHaveBeenCalled();
});

test.each(['', '0', '-1', '1.5', 'NaN', '1e2', '12junk', '9007199254740992'])('rejects invalid cursor %j before reading history', async (before) => {
  expect((await get(`sessionId=session-a&before=${encodeURIComponent(before)}`)).status).toBe(400);
  expect(mocks.getGatewayHistory).not.toHaveBeenCalled();
  expect(mocks.ensureGatewayBootstrapAutostart).not.toHaveBeenCalled();
});

test('initial requests preserve bootstrap behavior and expose the end of history', async () => {
  mocks.getGatewayHistory.mockReturnValue({ sessionId: 'session-a', history: [], branchFamilies: [], nextCursor: null });
  expect((await get('sessionId=session-a&limit=80')).body.nextCursor).toBeNull();
  expect(mocks.ensureGatewayBootstrapAutostart).toHaveBeenCalledTimes(1);
  expect(mocks.getGatewayHistory).toHaveBeenCalledWith('session-a', 80, { operatorUserId: 'authenticated-user' });
});

test.each([
  { query: 'before=42', malformed: false },
  { query: 'sessionId=malformed&before=42', malformed: true },
  { query: 'sessionId=session-a&before=42&agentId=../bad', malformed: false },
])('keeps session and agent validation before paging: $query', async ({ query, malformed }) => {
  expect((await get(query, malformed)).status).toBe(400);
  expect(mocks.getGatewayHistory).not.toHaveBeenCalled();
});
