import { expect, test, vi } from 'vitest';

import {
  APP_NOTICE_SOURCE,
  isHiddenUserSource,
  userTurnSource,
} from '../src/gateway/user-turn-source.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-user-turn-source-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('only an answer or an app notice is tagged, and only tags are hidden', () => {
  expect(userTurnSource({})).toBeNull();
  expect(userTurnSource({ appNotice: true })).toBe(APP_NOTICE_SOURCE);
  expect(
    userTurnSource({ approval: { approvalId: '1a2b3c4d', decision: 'yes' } }),
  ).toBe('approval');
  expect(isHiddenUserSource(APP_NOTICE_SOURCE)).toBe(true);
  expect(isHiddenUserSource(null)).toBe(false);
  expect(isHiddenUserSource('schedule:3')).toBe(false);
});

test('an app notice reaches the agent but stays out of history', async () => {
  setupHome();
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Signed in, carrying on.',
    toolsUsed: [],
    toolExecutions: [],
  });
  const { initDatabase } = await import('../src/memory/db.js');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.js'
  );
  initDatabase({ quiet: true });
  const request = {
    sessionId: 'web:app-notice',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'web',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
  };
  const notice = 'I saved my sign-in for example.com. Please continue.';

  await handleGatewayMessage({ ...request, content: notice, appNotice: true });
  // The same words typed by the user stay a message of theirs.
  await handleGatewayMessage({ ...request, content: notice });

  expect(runAgentMock.mock.calls[0][0].messages.at(-1)).toMatchObject({
    role: 'user',
    content: expect.stringContaining(notice),
  });
  const history = getGatewayHistory(request.sessionId).history;
  expect(
    history.filter((m) => m.role === 'user').map((m) => m.content),
  ).toEqual([notice]);
  expect(history.filter((m) => m.role === 'assistant')).toHaveLength(2);
});
