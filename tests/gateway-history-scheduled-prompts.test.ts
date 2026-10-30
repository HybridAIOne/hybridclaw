import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-history-scheduled-prompts-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

async function load() {
  setupHome();
  const db = await import('../src/memory/db.js');
  const { memoryService } = await import('../src/memory/memory-service.js');
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.js'
  );
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('web:scheduled-prompts', null, 'web');
  return { db, memoryService, getGatewayHistory, session };
}

test('stored scheduler prompts stay out of chat history without changing persisted context', async () => {
  const { db, memoryService, getGatewayHistory, session } = await load();
  const prompt = '[cron:#7] Check the weather for tomorrow.';
  const reply = 'Rain is expected tomorrow.';
  memoryService.storeTurn({
    sessionId: session.id,
    user: { userId: 'scheduler', username: 'scheduler', content: prompt },
    assistant: { content: reply, source: 'schedule:7' },
  });
  // A display name or identical wording does not make a human turn internal.
  db.storeMessage(session.id, 'user_a', 'scheduler', 'user', prompt);

  expect(
    getGatewayHistory(session.id).history.map(({ role, content }) => ({
      role,
      content,
    })),
  ).toEqual([
    { role: 'assistant', content: reply },
    { role: 'user', content: prompt },
  ]);
  expect(memoryService.getRecentMessages(session.id)).toHaveLength(3);
  expect(memoryService.getRecentMessages(session.id)[0]).toMatchObject({
    role: 'user',
    user_id: 'scheduler',
    source: null,
    content: prompt,
  });
});

test.each([
  { taskId: 7, reply: 'Remember to water the plants.', visible: true },
  { taskId: -1, reply: 'Your daily summary is ready.', visible: true },
  { taskId: 8, reply: '__MESSAGE_SEND_HANDLED__', visible: false },
])(
  'scheduled run $taskId exposes only its visible reply',
  async ({ taskId, reply, visible }) => {
    const { memoryService, getGatewayHistory, session } = await load();
    const { runIsolatedScheduledTask } = await import(
      '../src/scheduler/scheduled-task-runner.js'
    );
    const prompt = 'Check whether the plants need watering.';
    runAgentMock.mockResolvedValue({
      status: 'success',
      result: reply,
      toolsUsed: [],
      toolExecutions: [],
      artifacts: [],
    });
    const onResult = vi.fn();
    const onError = vi.fn();

    await runIsolatedScheduledTask({
      taskId,
      prompt,
      channelId: 'web',
      chatbotId: '',
      model: 'gpt-4o-mini',
      agentId: session.agent_id,
      sessionId: session.id,
      onResult,
      onError,
    });

    expect(onError).not.toHaveBeenCalled();
    expect(runAgentMock.mock.calls[0][0].messages.at(-1)).toEqual({
      role: 'user',
      content: prompt,
    });
    expect(memoryService.getRecentMessages(session.id)).toHaveLength(2);
    expect(
      getGatewayHistory(session.id).history.map((message) => message.content),
    ).toEqual(visible ? [reply] : []);
    expect(onResult).toHaveBeenCalledTimes(visible ? 1 : 0);
  },
);
