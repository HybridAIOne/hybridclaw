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
