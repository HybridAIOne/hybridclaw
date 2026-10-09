import { expect, it, test, vi } from 'vitest';

import {
  approvalAnswerText,
  parseApprovalAnswer,
} from '../src/gateway/approval-answer.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-approval-answer-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

it.each([
  [undefined, undefined],
  [{ approvalId: '1a2b3c4d', decision: 'yes' }, 'yes 1a2b3c4d'],
  [{ approvalId: '1a2b3c4d', decision: 'no' }, 'no 1a2b3c4d'],
  [{ approvalId: '1a2b3c4d', decision: 'session' }, 'yes 1a2b3c4d for session'],
  [{ approvalId: '1a2b3c4d', decision: 'maybe' }, null],
  [{ approvalId: 'not an id', decision: 'yes' }, null],
  [{ decision: 'yes' }, null],
  ['yes 1a2b3c4d', null],
])('approval %j is sent to the agent as %j', (body, text) => {
  const answer = parseApprovalAnswer(body);
  expect(answer ? approvalAnswerText(answer) : answer).toBe(text);
});

test('an approval answer reaches the agent but stays out of history', async () => {
  setupHome();
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Done, the file is gone.',
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
    sessionId: 'web:approval-answer',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'web',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
  };

  await handleGatewayMessage({
    ...request,
    content: 'yes 1a2b3c4d',
    approval: { approvalId: '1a2b3c4d', decision: 'yes' },
  });
  await handleGatewayMessage({ ...request, content: 'no facade' });

  expect(runAgentMock.mock.calls[0][0].messages.at(-1)).toMatchObject({
    role: 'user',
    content: expect.stringContaining('yes 1a2b3c4d'),
  });
  const history = getGatewayHistory(request.sessionId).history;
  expect(
    history.filter((m) => m.role === 'user').map((m) => m.content),
  ).toEqual(['no facade']);
  expect(history.filter((m) => m.role === 'assistant')).toHaveLength(2);
});
