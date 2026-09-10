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

test.each([
  'empty',
  'deleted',
  'low-confidence',
  'other-session',
])('skips semantic recall and memory activity for %s session memory', async (state) => {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  db.initDatabase({ quiet: true });
  const session = memoryService.getOrCreateSession(
    'session-empty-memory',
    null,
    'web',
  );
  if (state !== 'empty') {
    const target =
      state === 'other-session'
        ? memoryService.getOrCreateSession('session-other', null, 'web')
        : session;
    db.storeSemanticMemory({
      sessionId: target.id,
      role: 'assistant',
      content: 'User prefers concise answers.',
      confidence: state === 'low-confidence' ? 0.199 : 1,
      deleted: state === 'deleted',
    });
  }
  const recall = vi.spyOn(memoryService, 'recallSemanticMemories');
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Hello.',
    toolsUsed: [],
    toolExecutions: [],
  });
  const onToolProgress = vi.fn();
  const request = {
    sessionId: 'session-empty-memory',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    content: 'Do you remember my preferences?',
    model: 'test-model',
    chatbotId: 'test-bot',
    onToolProgress,
  };
  const result = await handleGatewayMessage(request);

  expect(result.status).toBe('success');
  expect(recall).not.toHaveBeenCalled();
  expect(result.memoryAccess).toBeUndefined();
  expect(onToolProgress).not.toHaveBeenCalled();

  if (state === 'empty') {
    const next = await handleGatewayMessage(request);
    expect(next.status).toBe('success');
    expect(recall).toHaveBeenCalledOnce();
    expect(next.memoryAccess?.semanticRecallAttempted).toBe(true);
    expect(onToolProgress).toHaveBeenCalledTimes(2);
  }
});

test.each([
  false,
  true,
])('reports summary-only memory access unless the summary is stale (%s)', async (stale) => {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  db.initDatabase({ quiet: true });
  const session = memoryService.getOrCreateSession(
    'session-summary-memory',
    null,
    'web',
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');
  ensureBootstrapFiles('main');
  db.updateSessionSummary(session.id, 'User prefers concise answers.');
  if (stale) {
    db.withMemoryDatabase((database) =>
      database
        .prepare(
          "UPDATE sessions SET summary_updated_at = datetime('now', '-365 days') WHERE id = ?",
        )
        .run(session.id),
    );
  }
  const eventOrder: string[] = [];
  const buildPromptMemoryContext =
    memoryService.buildPromptMemoryContext.bind(memoryService);
  vi.spyOn(memoryService, 'buildPromptMemoryContext').mockImplementation(
    (params) => {
      const result = buildPromptMemoryContext(params);
      eventOrder.push('context-built');
      return result;
    },
  );
  const recall = vi.spyOn(memoryService, 'recallSemanticMemories');
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Hello.',
    toolsUsed: [],
    toolExecutions: [],
  });
  const onToolProgress = vi.fn((event: { phase: 'start' | 'finish' }) => {
    eventOrder.push(event.phase);
  });
  const result = await handleGatewayMessage({
    sessionId: 'session-summary-memory',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    content: 'Hello',
    model: 'test-model',
    chatbotId: 'test-bot',
    onToolProgress,
  });

  expect(result.status).toBe('success');
  expect(recall).not.toHaveBeenCalled();
  if (stale) {
    expect(result.memoryAccess).toBeUndefined();
    expect(onToolProgress).not.toHaveBeenCalled();
    expect(eventOrder).toEqual(['context-built']);
  } else {
    expect(eventOrder).toEqual(['start', 'context-built', 'finish']);
    expect(result.memoryAccess).toEqual({
      semanticRecallAttempted: false,
      summaryIncluded: true,
      recalledMemories: [],
    });
    expect(onToolProgress).toHaveBeenCalledTimes(2);
    expect(onToolProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'finish',
        preview: 'Session summary accessed',
      }),
    );
  }
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
  memoryService.getOrCreateSession('session-memory-citations', null, 'web');
  updateSessionShowMode('session-memory-citations', 'none');
  vi.spyOn(memoryService, 'buildPromptMemoryContext').mockImplementation(
    (params) => {
      params.onMemoryAccess?.('semantic');
      return {
        semanticRecallAttempted: true,
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
      };
    },
  );
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
