import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-memory-citations-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('handleGatewayMessage extracts cited memory references from the model response', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  vi.spyOn(memoryService, 'buildPromptMemoryContext').mockReturnValue({
    promptSummary:
      '### Relevant Memory Recall\nIf you use any of these memories in your response, cite them inline using their tag (e.g. [mem:1]).\n- [mem:1] (90%) User prefers concise changelog entries.',
    summaryConfidence: null,
    semanticMemories: [],
    citationIndex: [
      {
        ref: '[mem:1]',
        memoryId: 7,
        content: 'User prefers concise changelog entries.',
        confidence: 0.9,
      },
    ],
  });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Based on [mem:1], you prefer concise changelog entries.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-memory-citations',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'What do you remember about my writing preferences?',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.memoryCitations).toEqual([
    {
      ref: '[mem:1]',
      memoryId: 7,
      content: 'User prefers concise changelog entries.',
      confidence: 0.9,
    },
  ]);
});
