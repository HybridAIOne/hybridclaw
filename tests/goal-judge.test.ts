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

test('goal judge keeps the goal open on malformed model output', async () => {
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

test.each([
  ['Prepare the report and pass its checks.', 'Goal complete.', false],
  ['Write a three-item checklist.', 'One. Two. Three.', true],
  [
    'Prepare a report.',
    'The goal is complete, but the file is missing.',
    false,
  ],
])(
  'independent evaluation decides completion for %s',
  async (goalText, assistantResponse, done) => {
    const modelCaller = vi.fn<
      NonNullable<Parameters<typeof judgeGoalCompletion>[0]['modelCaller']>
    >(async () => ({
      content: JSON.stringify({
        done,
        reason: 'Checked the requested conditions.',
      }),
    }));
    const verdict = await judgeGoalCompletion({
      sessionId: 'checked',
      agentId: 'hy',
      goalText,
      assistantResponse,
      executionEvidence: 'A recorded file check failed.',
      modelCaller,
    });
    expect(verdict.done).toBe(done);
    expect(modelCaller).toHaveBeenCalledOnce();
    const payload = JSON.parse(
      modelCaller.mock.calls[0][0].messages[1].content as string,
    );
    expect(payload.execution_evidence).toBe('A recorded file check failed.');
  },
);

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
