import { beforeEach, expect, test, vi } from 'vitest';
import {
  judgeGoalCompletion,
  parseGoalJudgeVerdict,
} from '../src/goals/goal-judge.js';

const mocks = vi.hoisted(() => ({
  callAuxiliaryModel: vi.fn(),
}));

vi.mock('../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: mocks.callAuxiliaryModel,
}));

beforeEach(() => {
  mocks.callAuxiliaryModel.mockReset();
});

test('parses strict goal judge JSON verdicts', () => {
  expect(
    parseGoalJudgeVerdict('{"done":true,"reason":"all requested files exist"}'),
  ).toEqual({
    done: true,
    reason: 'all requested files exist',
  });
  expect(() =>
    parseGoalJudgeVerdict('```json\n{"done":true,"reason":"done"}\n```'),
  ).toThrow();
});

test('goal judge fails open on malformed model output', async () => {
  const verdict = await judgeGoalCompletion({
    sessionId: 'session-a',
    agentId: 'agent-a',
    goalText: 'finish the report',
    assistantResponse: 'I updated the draft.',
    modelCaller: async () => ({
      content: 'looks complete',
      model: 'test-judge',
    }),
  });

  expect(verdict.done).toBe(false);
  expect(verdict.parseFailure).toBe(true);
});

test('goal judge sends conversation context to the model', async () => {
  const modelCaller = vi.fn(async () => ({
    content: '{"done":false,"reason":"Tests are not shown passing yet."}',
    model: 'test-judge',
  }));

  await judgeGoalCompletion({
    sessionId: 'session-context',
    agentId: 'agent-a',
    goalText: 'all auth tests pass',
    assistantResponse: 'I fixed the assertion.',
    conversationContext:
      'User: /goal all auth tests pass\n\nAssistant: npm test reported one failing auth test.',
    modelCaller,
  });

  const userMessage = modelCaller.mock.calls[0]?.[0].messages.find(
    (message) => message.role === 'user',
  );
  expect(userMessage?.content).toEqual(
    expect.stringContaining('conversation_context'),
  );
  expect(userMessage?.content).toEqual(
    expect.stringContaining('npm test reported one failing auth test'),
  );
});

test('goal judge treats explicit completion statements as terminal', async () => {
  const modelCaller = vi.fn();
  const verdict = await judgeGoalCompletion({
    sessionId: 'session-complete',
    agentId: 'agent-a',
    goalText:
      'Count from 1 to 4, one number per turn. When you reach 4, state that the goal is complete.',
    assistantResponse: '4\n\nGoal complete.',
    modelCaller,
  });

  expect(verdict).toEqual({
    done: true,
    reason: 'assistant explicitly stated the goal is complete',
    parseFailure: false,
  });
  expect(modelCaller).not.toHaveBeenCalled();
});

test('goal judge handles intermediate count goals without auxiliary parsing', async () => {
  const modelCaller = vi.fn();
  const verdict = await judgeGoalCompletion({
    sessionId: 'session-count',
    agentId: 'agent-a',
    goalText:
      'Count from 1 to 4, one number per turn. When you reach 4, state that the goal is complete.',
    assistantResponse: '3',
    modelCaller,
  });

  expect(verdict).toEqual({
    done: false,
    reason: 'count has reached 3, target is 4',
    parseFailure: false,
  });
  expect(modelCaller).not.toHaveBeenCalled();
});

test('goal judge does not accept early count completion claims', async () => {
  const modelCaller = vi.fn();
  const verdict = await judgeGoalCompletion({
    sessionId: 'session-count-early',
    agentId: 'agent-a',
    goalText:
      'Count from 1 to 4, one number per turn. When you reach 4, state that the goal is complete.',
    assistantResponse: '3\n\nGoal complete.',
    modelCaller,
  });

  expect(verdict).toEqual({
    done: false,
    reason: 'count has reached 3, target is 4',
    parseFailure: false,
  });
  expect(modelCaller).not.toHaveBeenCalled();
});

test('goal judge ignores future count steps when the current count is incomplete', async () => {
  const modelCaller = vi.fn();
  const verdict = await judgeGoalCompletion({
    sessionId: 'session-count-scheduled',
    agentId: 'agent-a',
    goalText:
      'Count from 1 to 4, one number per turn. When you reach 4, state that the goal is complete.',
    assistantResponse:
      '2\n\nNext three steps scheduled:\n- **3** in 30s\n- **4** in 60s\n- **Goal complete** in 90s',
    modelCaller,
  });

  expect(verdict).toEqual({
    done: false,
    reason: 'count has reached 2, target is 4',
    parseFailure: false,
  });
  expect(modelCaller).not.toHaveBeenCalled();
});

test('goal judge retries without structured response format on empty local output', async () => {
  mocks.callAuxiliaryModel
    .mockRejectedValueOnce(new Error('goal_judge returned an empty response.'))
    .mockResolvedValueOnce({
      content: '{"done":false,"reason":"The count has not reached 4 yet."}',
      model: 'test-judge',
    });

  const verdict = await judgeGoalCompletion({
    sessionId: 'session-b',
    agentId: 'agent-b',
    goalText: 'Draft a three-step smoke test checklist for the /goal feature.',
    assistantResponse: 'I wrote the first checklist item.',
  });

  expect(verdict).toEqual({
    done: false,
    reason: 'The count has not reached 4 yet.',
    parseFailure: false,
  });
  expect(mocks.callAuxiliaryModel).toHaveBeenCalledTimes(2);
  expect(mocks.callAuxiliaryModel).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      extraBody: {
        response_format: { type: 'json_object' },
      },
    }),
  );
  expect(mocks.callAuxiliaryModel).toHaveBeenNthCalledWith(
    2,
    expect.not.objectContaining({
      extraBody: expect.anything(),
    }),
  );
});
