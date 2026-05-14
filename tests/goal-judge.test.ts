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
    goalText:
      'Count from 1 to 4, one number per turn. When you reach 4, state that the goal is complete.',
    assistantResponse: '3',
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
