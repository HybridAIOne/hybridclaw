import { afterEach, expect, test, vi } from 'vitest';
import type { CompactionResult } from '../src/types/memory.js';
import type { StoredMessage } from '../src/types/session.js';

const { ensurePluginManagerInitializedMock, loggerMock, memoryServiceMock } =
  vi.hoisted(() => ({
    ensurePluginManagerInitializedMock: vi.fn(),
    loggerMock: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    memoryServiceMock: {
      compactSession: vi.fn(),
      getCompactionCandidateMessages: vi.fn(),
      getRecentMessages: vi.fn(),
      getSessionById: vi.fn(),
      markSessionMemoryFlush: vi.fn(),
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

vi.mock('../src/providers/model-catalog.js', () => ({
  getModelCatalogMetadata: vi.fn(() => ({ contextWindow: 128_000 })),
}));

vi.mock('../src/providers/task-routing.js', () => ({
  resolveTaskModelPolicy: vi.fn(async () => null),
}));

vi.mock('../src/skills/skills.js', () => ({
  loadSkills: vi.fn(() => []),
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

function makeResult(partial?: Partial<CompactionResult>): CompactionResult {
  return {
    tokensBefore: 100,
    tokensAfter: 40,
    messagesCompacted: 2,
    messagesPreserved: 1,
    archivePath: '/tmp/archive.json',
    durationMs: 5,
    stages: [],
    ...(partial || {}),
  };
}

const target = {
  sessionId: 'session-1',
  agentId: 'main',
  chatbotId: 'bot-1',
  enableRag: true,
  model: 'test-model',
  channelId: 'web',
};

afterEach(() => {
  ensurePluginManagerInitializedMock.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  memoryServiceMock.compactSession.mockReset();
  memoryServiceMock.getCompactionCandidateMessages.mockReset();
  memoryServiceMock.getRecentMessages.mockReset();
  memoryServiceMock.getSessionById.mockReset();
  memoryServiceMock.markSessionMemoryFlush.mockReset();
  vi.resetModules();
});

test('maybeCompactSession continues when plugin manager init fails', async () => {
  const allMessages = [
    makeStoredMessage(1, 'user', 'first'),
    makeStoredMessage(2, 'assistant', 'second'),
    makeStoredMessage(3, 'user', 'third'),
  ];
  memoryServiceMock.getSessionById.mockReturnValue({
    id: 'session-1',
    session_summary: 'previous summary',
    message_count: 25,
  });
  memoryServiceMock.getRecentMessages.mockReturnValue(allMessages);
  memoryServiceMock.getCompactionCandidateMessages.mockReturnValue({
    olderMessages: allMessages.slice(0, 1),
    cutoffId: 2,
  });
  memoryServiceMock.compactSession.mockResolvedValue(makeResult());
  ensurePluginManagerInitializedMock.mockRejectedValue(
    new Error('plugin init failed'),
  );

  const { maybeCompactSession } = await import(
    '../src/session/session-maintenance.js'
  );

  await expect(maybeCompactSession(target)).resolves.toBeUndefined();

  expect(memoryServiceMock.compactSession).toHaveBeenCalledWith('session-1', {
    retainRecentCount: 2,
  });
  expect(loggerMock.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-1',
      agentId: 'main',
      channelId: 'web',
    }),
    'Plugin manager init failed; proceeding without compaction plugin hooks',
  );
  expect(loggerMock.info).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-1', compacted: 2 }),
    'Session compacted',
  );
});

test('maybeCompactSession skips built-in compaction when a plugin replaces memory', async () => {
  const allMessages = [
    makeStoredMessage(1, 'user', 'first'),
    makeStoredMessage(2, 'assistant', 'second'),
    makeStoredMessage(3, 'user', 'third'),
  ];
  const olderMessages = allMessages.slice(0, 2);
  memoryServiceMock.getSessionById.mockReturnValue({
    id: 'session-1',
    session_summary: 'previous summary',
    message_count: 25,
  });
  memoryServiceMock.getRecentMessages.mockReturnValue(allMessages);
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

  await expect(maybeCompactSession(target)).resolves.toBeUndefined();

  expect(memoryServiceMock.compactSession).not.toHaveBeenCalled();
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

  await maybeCompactSession({ ...target, promptOverheadTokens: 100 });

  expect(memoryServiceMock.getCompactionCandidateMessages).not.toHaveBeenCalled();
  expect(memoryServiceMock.compactSession).not.toHaveBeenCalled();
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
  memoryServiceMock.getRecentMessages.mockReturnValue(allMessages);
  memoryServiceMock.getCompactionCandidateMessages.mockReturnValue({
    olderMessages: allMessages.slice(0, 2),
    cutoffId: 3,
  });
  memoryServiceMock.compactSession.mockResolvedValue(makeResult());
  ensurePluginManagerInitializedMock.mockResolvedValue(null);

  const { maybeCompactSession } = await import(
    '../src/session/session-maintenance.js'
  );

  await maybeCompactSession({ ...target, promptOverheadTokens: 100 });

  // 2,700 stored tokens exceed the 2,000 floor. Half of that budget (1,000)
  // retains the two newest turns (900 tokens); the 1,800-token oldest turn
  // would push the retained slice past the share.
  expect(memoryServiceMock.getCompactionCandidateMessages).toHaveBeenCalledWith(
    'session-1',
    4,
  );
  expect(memoryServiceMock.compactSession).toHaveBeenCalledWith('session-1', {
    retainRecentCount: 4,
  });
});

test('compactSessionNow runs the engine regardless of the trigger and reports nothing to compact', async () => {
  const allMessages = [
    makeStoredMessage(1, 'user', 'first'),
    makeStoredMessage(2, 'assistant', 'second'),
    makeStoredMessage(3, 'user', 'third'),
  ];
  memoryServiceMock.getSessionById.mockReturnValue({
    id: 'session-1',
    session_summary: null,
    message_count: 3,
  });
  memoryServiceMock.getRecentMessages.mockReturnValue(allMessages);
  memoryServiceMock.getCompactionCandidateMessages.mockReturnValue({
    olderMessages: allMessages.slice(0, 1),
    cutoffId: 2,
  });
  ensurePluginManagerInitializedMock.mockResolvedValue(null);
  memoryServiceMock.compactSession.mockResolvedValueOnce(
    makeResult({ messagesCompacted: 1 }),
  );

  const { compactSessionNow } = await import(
    '../src/session/session-maintenance.js'
  );
  const { NoCompactableMessagesError } = await import(
    '../src/memory/compaction.js'
  );

  await expect(compactSessionNow(target)).resolves.toEqual(
    expect.objectContaining({ messagesCompacted: 1 }),
  );
  expect(memoryServiceMock.compactSession).toHaveBeenCalledWith('session-1', {
    retainRecentCount: 2,
  });

  memoryServiceMock.compactSession.mockRejectedValueOnce(
    new NoCompactableMessagesError('session-1'),
  );
  await expect(compactSessionNow(target)).resolves.toBeNull();

  memoryServiceMock.getCompactionCandidateMessages.mockReturnValue(null);
  await expect(compactSessionNow(target)).resolves.toBeNull();
  expect(memoryServiceMock.compactSession).toHaveBeenCalledTimes(2);
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
