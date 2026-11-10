import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
});

vi.mock('../src/providers/model-catalog.js', () => ({
  getModelCatalogMetadata: vi.fn(() => ({ contextWindow: 8_000 })),
}));

async function createWorkspace(agentId: string): Promise<void> {
  const dataDir = makeTempDir('hybridclaw-history-window-');
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const workspaceDir = agentWorkspaceDir(agentId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'MEMORY.md'),
    '# MEMORY.md\n\n- Stable durable memory.\n',
    'utf-8',
  );
}

function makeTurn(index: number, chars: number) {
  return [
    { role: 'assistant', content: `answer ${index} ${'a'.repeat(chars)}` },
    { role: 'user', content: `question ${index} ${'q'.repeat(chars)}` },
  ];
}

test('buildConversationContext drops the oldest turns and says so in the dynamic context', async () => {
  const agentId = 'history-window-agent';
  await createWorkspace(agentId);
  const { buildConversationContext } = await import(
    '../src/agent/conversation.js'
  );

  // Newest-first, as storage returns it. Each turn is roughly 2,000 tokens,
  // well above the 8k-window budget once bootstrap overhead is subtracted.
  const history = [...makeTurn(3, 4_000), ...makeTurn(2, 4_000), ...makeTurn(1, 4_000)];

  const context = buildConversationContext({
    agentId,
    history,
    runtimeInfo: { model: 'gpt-5-nano', workspacePath: '/workspace/x' },
  });

  expect(context.historyStats.droppedTurns).toBeGreaterThan(0);
  expect(context.historyStats.includedCount).toBeLessThan(history.length);
  expect(context.promptOverheadTokens).toBeGreaterThan(0);

  const historyMessages = context.messages.filter(
    (message) => message.role !== 'system',
  );
  expect(String(historyMessages[0]?.content)).toContain('question 3');
  expect(
    context.messages.some((message) =>
      String(message.content).includes('question 1'),
    ),
  ).toBe(false);

  const dynamicContext = String(context.messages.at(-1)?.content);
  expect(dynamicContext).toContain('## History Window');
  expect(dynamicContext).toContain(
    `The oldest ${context.historyStats.droppedTurns} turn(s)`,
  );
});

test('a daily note returns once the turn that showed it leaves the history window', async () => {
  const agentId = 'history-window-note-agent';
  await createWorkspace(agentId);
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { buildConversationContext } = await import(
    '../src/agent/conversation.js'
  );
  const latestContextWith = (history: ReturnType<typeof makeTurn>) => {
    const context = buildConversationContext({
      agentId,
      history,
      runtimeInfo: { model: 'gpt-5-nano', workspacePath: '/workspace/x' },
    });
    return {
      droppedTurns: context.historyStats.droppedTurns,
      latest: String(context.messages.at(-1)?.content),
    };
  };
  const notePath = path.join(
    agentWorkspaceDir(agentId),
    /Daily note: (memory\/\S+\.md)/.exec(latestContextWith([]).latest)?.[1] ??
      '',
  );
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, '- Prefers tea.\n');
  const shownWithTurn = latestContextWith([]).latest;
  expect(shownWithTurn).toContain('- Prefers tea.');
  const historyWith = (firstTurnChars: number) => {
    const [answer, question] = makeTurn(1, firstTurnChars);
    return [
      ...makeTurn(2, 20),
      answer,
      { ...question, dynamic_context: shownWithTurn },
    ];
  };

  const kept = latestContextWith(historyWith(20));
  expect(kept.droppedTurns).toBe(0);
  expect(kept.latest).not.toContain('- Prefers tea.');

  const dropped = latestContextWith(historyWith(12_000));
  expect(dropped.droppedTurns).toBe(1);
  expect(dropped.latest).toContain('- Prefers tea.');
});

test('an earlier day note the history still shows is marked empty once it is no longer loaded', async () => {
  const agentId = 'history-window-earlier-note-agent';
  await createWorkspace(agentId);
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { buildConversationContext } = await import(
    '../src/agent/conversation.js'
  );
  const latestContextWith = (history: ReturnType<typeof makeTurn>) =>
    String(
      buildConversationContext({
        agentId,
        history,
        runtimeInfo: { model: 'gpt-5-nano', workspacePath: '/workspace/x' },
      }).messages.at(-1)?.content,
    );
  const today = /Daily note: memory\/(\S+)\.md/.exec(latestContextWith([]))?.[1];
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const notePath = path.join(
    agentWorkspaceDir(agentId),
    'memory',
    `${yesterday}.md`,
  );
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, '- Prefers tea.\n');
  const shownWithTurn = latestContextWith([]);
  expect(shownWithTurn).toContain('- Prefers tea.');
  const [answer, question] = makeTurn(1, 20);
  const history = [answer, { ...question, dynamic_context: shownWithTurn }];

  fs.rmSync(notePath);
  const cleared = latestContextWith(history);
  expect(cleared).toContain(`## Daily Memory (memory/${yesterday}.md)\n\n(empty)`);

  const [nextAnswer, nextQuestion] = makeTurn(2, 20);
  expect(
    latestContextWith([
      nextAnswer,
      { ...nextQuestion, dynamic_context: cleared },
      ...history,
    ]),
  ).not.toContain('## Daily Memory');
});

test('buildConversationContext omits the history window note when everything fits', async () => {
  const agentId = 'history-window-fit-agent';
  await createWorkspace(agentId);
  const { buildConversationContext } = await import(
    '../src/agent/conversation.js'
  );

  const context = buildConversationContext({
    agentId,
    history: [...makeTurn(1, 20)],
    runtimeInfo: { model: 'gpt-5-nano', workspacePath: '/workspace/x' },
  });

  expect(context.historyStats.droppedTurns).toBe(0);
  expect(String(context.messages.at(-1)?.content)).not.toContain(
    '## History Window',
  );
});

test('buildConversationContext reports a truncated history fetch', async () => {
  const agentId = 'history-window-truncated-agent';
  await createWorkspace(agentId);
  const { buildConversationContext } = await import(
    '../src/agent/conversation.js'
  );

  const context = buildConversationContext({
    agentId,
    history: [...makeTurn(1, 20)],
    historyTruncated: true,
    runtimeInfo: { model: 'gpt-5-nano', workspacePath: '/workspace/x' },
  });

  expect(String(context.messages.at(-1)?.content)).toContain(
    'beyond the loaded history window',
  );
});
