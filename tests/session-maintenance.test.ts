import { afterEach, expect, test, vi } from 'vitest';
import type { StoredMessage } from '../src/types/session.js';

const {
  callAuxiliaryModelMock,
  ensurePluginManagerInitializedMock,
  exportCompactedSessionJsonlMock,
  loggerMock,
  memoryServiceMock,
} = vi.hoisted(() => ({
  callAuxiliaryModelMock: vi.fn(),
  ensurePluginManagerInitializedMock: vi.fn(),
  exportCompactedSessionJsonlMock: vi.fn(() => null),
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  memoryServiceMock: {
    deleteMessagesBeforeId: vi.fn(),
    getCompactionCandidateMessages: vi.fn(),
    getRecentMessages: vi.fn(),
    getSessionById: vi.fn(),
    markSessionMemoryFlush: vi.fn(),
    updateSessionSummary: vi.fn(),
  },
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../src/agent/prompt-hooks.js', () => ({
  buildSystemPromptFromHooks: vi.fn(() => 'system prompt'),
}));

vi.mock('../src/config/config.js', () => ({
  CONTAINER_WARM_POOL: {
    coldStartBudgetMs: 10_000,
    enabled: false,
    maxIdlePerAgent: 1,
    memoryPressureRssMb: 0,
    minIdlePerActiveAgent: 0,
    trafficWindowMs: 60_000,
  },
  DATA_DIR: '/tmp/hybridclaw-test-data',
  PRE_COMPACTION_MEMORY_FLUSH_ENABLED: false,
  PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS: 8_000,
  PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES: 100,
  SESSION_COMPACTION_BUDGET_RATIO: 0.5,
  SESSION_COMPACTION_ENABLED: true,
  SESSION_COMPACTION_KEEP_RECENT: 4,
  SESSION_COMPACTION_SUMMARY_MAX_CHARS: 8_000,
  SESSION_COMPACTION_THRESHOLD: 20,
  SESSION_COMPACTION_TOKEN_BUDGET: 1_000,
  onConfigChange: vi.fn(() => () => {}),
}));

vi.mock('../src/infra/ipc.js', () => ({
  agentWorkspaceDir: vi.fn(() => '/tmp/agent'),
}));

vi.mock('../src/logger.js', () => ({
  logger: loggerMock,
}));

vi.mock('../src/memory/memory-service.js', () => ({
  memoryService: memoryServiceMock,
}));

vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: ensurePluginManagerInitializedMock,
}));

vi.mock('../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: callAuxiliaryModelMock,
}));

vi.mock('../src/providers/model-catalog.js', () => ({
  getModelCatalogMetadata: vi.fn(() => ({ contextWindow: 128_000 })),
}));

vi.mock('../src/providers/task-routing.js', () => ({
  resolveTaskModelPolicy: vi.fn(async () => null),
}));

vi.mock('../src/skills/skills.js', () => ({
  loadSkills: vi.fn(() => []),
}));

vi.mock('../src/session/session-export.js', () => ({
  exportCompactedSessionJsonl: exportCompactedSessionJsonlMock,
}));

vi.mock('../src/session/token-efficiency.js', () => ({
  estimateTokenCountFromMessages: vi.fn(
    (messages: Array<{ content: string | null }>) =>
      messages.reduce(
        (total, message) => total + (message.content?.length ?? 0),
        0,
      ),
  ),
  estimateTokenCountFromText: vi.fn(() => 0),
}));

function makeStoredMessage(
  id: number,
  role: string,
  content: string,
): StoredMessage {
  return {
    id,
    session_id: 'session-1',
    user_id: 'user-1',
    username: 'alice',
    role,
    content,
    created_at: '2026-03-18T18:00:00.000Z',
  };
}

afterEach(() => {
  callAuxiliaryModelMock.mockReset();
  ensurePluginManagerInitializedMock.mockReset();
  exportCompactedSessionJsonlMock.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  memoryServiceMock.deleteMessagesBeforeId.mockReset();
  memoryServiceMock.getCompactionCandidateMessages.mockReset();
  memoryServiceMock.getRecentMessages.mockReset();
  memoryServiceMock.getSessionById.mockReset();
  memoryServiceMock.markSessionMemoryFlush.mockReset();
  memoryServiceMock.updateSessionSummary.mockReset();
  vi.resetModules();
});

test('maybeCompactSession continues when plugin manager init fails', async () => {
  const allMessages = [
    makeStoredMessage(1, 'user', 'first'),
    makeStoredMessage(2, 'assistant', 'second'),
    makeStoredMessage(3, 'user', 'third'),
  ];
  const olderMessages = allMessages.slice(0, 2);
  const retainedMessages = allMessages.slice(2);

  memoryServiceMock.getSessionById.mockReturnValue({
    id: 'session-1',
    session_summary: 'previous summary',
    message_count: 25,
  });
  memoryServiceMock.getRecentMessages.mockImplementation(
    (_sessionId: string, keepRecent?: number) =>
      keepRecent ? retainedMessages : allMessages,
  );
  memoryServiceMock.getCompactionCandidateMessages.mockReturnValue({
    olderMessages,
    cutoffId: 2,
  });
  memoryServiceMock.deleteMessagesBeforeId.mockReturnValue(2);
  ensurePluginManagerInitializedMock.mockRejectedValue(
    new Error('plugin init failed'),
  );
  callAuxiliaryModelMock.mockResolvedValue({
    content: 'Compacted summary',
  });

  const { maybeCompactSession } = await import(
    '../src/session/session-maintenance.js'
  );

  await expect(
    maybeCompactSession({
      sessionId: 'session-1',
      agentId: 'main',
      chatbotId: 'bot-1',
      enableRag: true,
      model: 'test-model',
      channelId: 'web',
    }),
  ).resolves.toBeUndefined();

  expect(memoryServiceMock.deleteMessagesBeforeId).toHaveBeenCalledWith(
    'session-1',
    2,
  );
  expect(memoryServiceMock.updateSessionSummary).toHaveBeenCalledWith(
    'session-1',
    'Compacted summary',
  );
  expect(exportCompactedSessionJsonlMock).toHaveBeenCalled();
  expect(loggerMock.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-1',
      agentId: 'main',
      channelId: 'web',
    }),
    'Plugin manager init failed; proceeding without compaction plugin hooks',
  );
});

test('maybeCompactSession skips built-in compaction when a plugin replaces memory', async () => {
  const allMessages = [
    makeStoredMessage(1, 'user', 'first'),
    makeStoredMessage(2, 'assistant', 'second'),
    makeStoredMessage(3, 'user', 'third'),
  ];
  const olderMessages = allMessages.slice(0, 2);
  const retainedMessages = allMessages.slice(2);

  memoryServiceMock.getSessionById.mockReturnValue({
    id: 'session-1',
    session_summary: 'previous summary',
    message_count: 25,
  });
  memoryServiceMock.getRecentMessages.mockImplementation(
    (_sessionId: string, keepRecent?: number) =>
      keepRecent ? retainedMessages : allMessages,
  );
  memoryServiceMock.getCompactionCandidateMessages.mockReturnValue({
    olderMessages,
    cutoffId: 2,
  });
  const notifyBeforeCompactionMock = vi.fn(async () => {});
  ensurePluginManagerInitializedMock.mockResolvedValue({
    notifyBeforeCompaction: notifyBeforeCompactionMock,
    getMemoryLayerBehavior: vi.fn(async () => ({
      replacesBuiltInMemory: true,
    })),
  });

  const { maybeCompactSession } = await import(
    '../src/session/session-maintenance.js'
  );

  await expect(
    maybeCompactSession({
      sessionId: 'session-1',
      agentId: 'main',
      chatbotId: 'bot-1',
      enableRag: true,
      model: 'test-model',
      channelId: 'web',
    }),
  ).resolves.toBeUndefined();

  expect(callAuxiliaryModelMock).not.toHaveBeenCalled();
  expect(memoryServiceMock.deleteMessagesBeforeId).not.toHaveBeenCalled();
  expect(memoryServiceMock.updateSessionSummary).not.toHaveBeenCalled();
  expect(exportCompactedSessionJsonlMock).not.toHaveBeenCalled();
  expect(notifyBeforeCompactionMock).toHaveBeenCalledWith({
    sessionId: 'session-1',
    agentId: 'main',
    channelId: 'web',
    summary: 'previous summary',
    olderMessages,
  });
  expect(loggerMock.debug).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-1',
      agentId: 'main',
      channelId: 'web',
    }),
    'Session compaction skipped because a plugin memory layer replaces built-in memory',
  );
});

test('maybeCompactSession stays idle while stored history fits the budget', async () => {
  memoryServiceMock.getSessionById.mockReturnValue({
    id: 'session-1',
    session_summary: null,
    message_count: 4,
  });
  memoryServiceMock.getRecentMessages.mockReturnValue([
    makeStoredMessage(1, 'user', 'a'.repeat(100)),
    makeStoredMessage(2, 'assistant', 'b'.repeat(100)),
    makeStoredMessage(3, 'user', 'c'.repeat(100)),
    makeStoredMessage(4, 'assistant', 'd'.repeat(100)),
  ]);

  const { maybeCompactSession } = await import(
    '../src/session/session-maintenance.js'
  );

  await maybeCompactSession({
    sessionId: 'session-1',
    agentId: 'main',
    chatbotId: 'bot-1',
    enableRag: true,
    model: 'test-model',
    channelId: 'web',
    promptOverheadTokens: 100,
  });

  expect(memoryServiceMock.getCompactionCandidateMessages).not.toHaveBeenCalled();
  expect(loggerMock.debug).toHaveBeenCalledWith(
    expect.objectContaining({
      msgTokens: 400,
      promptOverheadTokens: 100,
      historyBudget: 2_000,
      shouldCompactForTokens: false,
      shouldCompactForMessageCount: false,
    }),
    'Session compaction budget check',
  );
});

test('maybeCompactSession compacts once stored history exceeds the history budget', async () => {
  const allMessages = [
    makeStoredMessage(1, 'user', 'a'.repeat(900)),
    makeStoredMessage(2, 'assistant', 'b'.repeat(900)),
    makeStoredMessage(3, 'user', 'c'.repeat(600)),
    makeStoredMessage(4, 'assistant', 'd'.repeat(100)),
    makeStoredMessage(5, 'user', 'e'.repeat(100)),
    makeStoredMessage(6, 'assistant', 'f'.repeat(100)),
  ];
  memoryServiceMock.getSessionById.mockReturnValue({
    id: 'session-1',
    session_summary: null,
    message_count: 6,
  });
  memoryServiceMock.getRecentMessages.mockImplementation(
    (_sessionId: string, keepRecent?: number) =>
      keepRecent ? allMessages.slice(-keepRecent) : allMessages,
  );
  memoryServiceMock.getCompactionCandidateMessages.mockReturnValue({
    olderMessages: allMessages.slice(0, 4),
    cutoffId: 5,
  });
  memoryServiceMock.deleteMessagesBeforeId.mockReturnValue(4);
  ensurePluginManagerInitializedMock.mockResolvedValue(null);
  callAuxiliaryModelMock.mockResolvedValue({ content: 'Compacted summary' });

  const { maybeCompactSession } = await import(
    '../src/session/session-maintenance.js'
  );

  await maybeCompactSession({
    sessionId: 'session-1',
    agentId: 'main',
    chatbotId: 'bot-1',
    enableRag: true,
    model: 'test-model',
    channelId: 'web',
    promptOverheadTokens: 100,
  });

  // 2,700 stored tokens exceed the 2,000 floor. Half of that budget (1,000)
  // retains the two newest turns (900 tokens); the 1,800-token oldest turn
  // would push the retained slice past the share.
  expect(memoryServiceMock.getCompactionCandidateMessages).toHaveBeenCalledWith(
    'session-1',
    4,
  );
  expect(memoryServiceMock.deleteMessagesBeforeId).toHaveBeenCalledWith(
    'session-1',
    5,
  );
  expect(memoryServiceMock.updateSessionSummary).toHaveBeenCalledWith(
    'session-1',
    'Compacted summary',
  );
});

test('resolveRetainedMessageCount always keeps the newest turn whole', async () => {
  const { resolveRetainedMessageCount } = await import(
    '../src/session/session-maintenance.js'
  );
  const messages = [
    makeStoredMessage(1, 'user', 'a'.repeat(50)),
    makeStoredMessage(2, 'assistant', 'b'.repeat(50)),
    makeStoredMessage(3, 'user', 'c'.repeat(50)),
    makeStoredMessage(4, 'assistant', 'd'.repeat(500)),
  ];

  expect(resolveRetainedMessageCount(messages, 40, 10)).toBe(2);
  expect(resolveRetainedMessageCount(messages, 40, 10_000)).toBe(4);
  expect(resolveRetainedMessageCount(messages, 3, 10_000)).toBe(2);
  expect(resolveRetainedMessageCount([], 40, 10_000)).toBe(0);
});
