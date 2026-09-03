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

  const { initDatabase, updateSessionShowMode } = await import(
    '../src/memory/db.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  memoryService.getOrCreateSession(
    'session-memory-citations',
    null,
    'web',
  );
  updateSessionShowMode('session-memory-citations', 'none');
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
      {
        ref: '[mem:2]',
        memoryId: 8,
        content: 'User works in Berlin.',
        confidence: 0.8,
      },
    ],
  });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Based on [mem:1], you prefer concise changelog entries.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const progressEvents: Array<{
    toolName: string;
    phase: 'start' | 'finish';
    preview?: string;
  }> = [];
  const result = await handleGatewayMessage({
    sessionId: 'session-memory-citations',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'What do you remember about my writing preferences?',
    model: 'test-model',
    chatbotId: 'bot-1',
    onToolProgress: (event) => progressEvents.push(event),
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
  expect(result.memoryAccess).toEqual({
    semanticRecallAttempted: true,
    summaryIncluded: false,
    recalledMemories: [
      {
        ref: '[mem:1]',
        memoryId: 7,
        content: 'User prefers concise changelog entries.',
        confidence: 0.9,
      },
      {
        ref: '[mem:2]',
        memoryId: 8,
        content: 'User works in Berlin.',
        confidence: 0.8,
      },
    ],
  });
  expect(progressEvents).toEqual([
    {
      sessionId: 'session-memory-citations',
      toolName: 'memory_recall',
      phase: 'start',
      preview: 'Searching semantic memory',
    },
    expect.objectContaining({
      sessionId: 'session-memory-citations',
      toolName: 'memory_recall',
      phase: 'finish',
      preview: expect.stringContaining('Recalled 2 memories'),
    }),
  ]);
});
