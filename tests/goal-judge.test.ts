import { expect, test } from 'vitest';
import {
  judgeGoalCompletion,
  parseGoalJudgeVerdict,
} from '../src/goals/goal-judge.js';

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
