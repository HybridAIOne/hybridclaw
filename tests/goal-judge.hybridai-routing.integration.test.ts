import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushAuditTrail } from '../src/audit/audit-trail.js';
import { HYBRIDAI_MODEL } from '../src/config/config.js';
import { getThreadGoal, setThreadGoal } from '../src/goals/goal-manager.js';
import {
  clearScheduledGoalContinuation,
  GOAL_CONTINUATION_SOURCE,
  maybeContinueGoalAfterTurn,
  setGoalContinuationRunHandler,
} from '../src/goals/goal-runtime.js';
import {
  initDatabase,
  updateSessionChatbot,
  updateSessionModel,
} from '../src/memory/db.js';
import { memoryService } from '../src/memory/memory-service.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../src/gateway/provider-status.js', () => ({
  getGatewayAdminProviderStatus: async () => ({}),
}));
vi.mock('../src/providers/local-health.js', () => ({
  localBackendsProbe: { get: async () => new Map(), peek: () => null },
}));

const makeTempDir = useTempDir('hybridclaw-goal-judge-hybridai-');
useCleanMocks({ unstubAllEnvs: true, unstubAllGlobals: true });

beforeEach(() => {
  initDatabase({
    quiet: true,
    dbPath: path.join(makeTempDir(), 'hybridclaw.db'),
  });
  vi.stubEnv('HYBRIDAI_API_KEY', 'test-key');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith('/chat/completions')
      ? Response.json({
          choices: [
            {
              message: {
                content: '{"done":false,"reason":"one section is missing"}',
              },
            },
          ],
        })
      : Response.json({ data: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  setGoalContinuationRunHandler(async () => {});
});
afterEach(flushAuditTrail);

function judgeRequestBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/chat/completions'))
    .map(([, init]) => JSON.parse(String(init?.body)));
}

test.each([
  {
    name: 'default-model session with a stored chatbot',
    sessionModel: null,
    req: {},
    expected: { model: HYBRIDAI_MODEL, chatbot_id: 'bot_session' },
  },
  {
    name: 'turn with a request model and chatbot',
    sessionModel: 'gpt-4.1-mini',
    req: { model: 'gpt-4.1-nano', chatbotId: 'bot_request' },
    expected: { model: 'gpt-4.1-nano', chatbot_id: 'bot_request' },
  },
])(
  'HybridAI-only goal judge runs on the turn model and chatbot: $name',
  async ({ sessionModel, req, expected }) => {
    const session = memoryService.getOrCreateSession(
      `goal-judge-${expected.chatbot_id}`,
      null,
      'tui',
      'main',
    );
    if (sessionModel) updateSessionModel(session.id, sessionModel);
    const turnSession = memoryService.getSessionById(session.id) ?? session;
    // The chat turn resolves the account chatbot after loading the session.
    updateSessionChatbot(session.id, 'bot_session');
    setThreadGoal({
      threadId: turnSession.main_session_key,
      goalText: 'write the release summary',
      maxTurns: 5,
      setterActor: { type: 'user', id: 'user_a' },
      targetAgentId: 'main',
    });

    await maybeContinueGoalAfterTurn({
      session: turnSession,
      req: {
        source: GOAL_CONTINUATION_SOURCE,
        guildId: null,
        userId: 'user_a',
        username: 'User A',
        ...req,
      },
      result: { status: 'success', result: 'Drafted two sections.', toolsUsed: [] },
    });
    clearScheduledGoalContinuation(session.id);

    expect(judgeRequestBodies()).toEqual([
      expect.objectContaining(expected),
    ]);
    expect(getThreadGoal(turnSession.main_session_key)).toMatchObject({
      status: 'active',
      turnsUsed: 1,
      consecutiveParseFailures: 0,
      lastReason: 'one section is missing',
    });
  },
);
