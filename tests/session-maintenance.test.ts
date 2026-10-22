import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DAILY_MEMORY_MAX_CHARS } from '../container/shared/daily-memory.js';
import { currentDateStampInTimezone } from '../container/shared/workspace-time.js';
import type { CompactionResult } from '../src/types/memory.js';
import type { StoredMessage } from '../src/types/session.js';
import { useTempDir } from './test-utils.js';

const {
  ensurePluginManagerInitializedMock,
  loggerMock,
  memoryServiceMock,
  flushConfig,
  scopeRunMock,
} = vi.hoisted(() => ({
  flushConfig: { enabled: false },
  scopeRunMock: {
    resolveScopeRun: vi.fn().mockResolvedValue(null),
    scopeRunAgentParams: vi.fn().mockReturnValue({}),
  },
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
  get PRE_COMPACTION_MEMORY_FLUSH_ENABLED() {
    return flushConfig.enabled;
  },
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

vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: vi.fn(),
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

vi.mock('../src/scopes/scope-run.js', () => ({
  ...scopeRunMock,
  isScopeRunError: (value: { errorCode?: string } | null) =>
    Boolean(value?.errorCode),
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

const makeTempDir = useTempDir('memory-flush-');

afterEach(() => {
  flushConfig.enabled = false;
  scopeRunMock.resolveScopeRun.mockReset().mockResolvedValue(null);
  scopeRunMock.scopeRunAgentParams.mockReset().mockReturnValue({});
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

  expect(
    memoryServiceMock.getCompactionCandidateMessages,
  ).not.toHaveBeenCalled();
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

async function prepareFlush() {
  flushConfig.enabled = true;
  const workspace = makeTempDir();
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  vi.mocked(agentWorkspaceDir).mockReturnValue(workspace);
  const { runAgent } = await import('../src/agent/agent.js');
  vi.mocked(runAgent).mockReset();
  const maintenance = await import('../src/session/session-maintenance.js');
  const params = {
    ...target,
    sessionSummary: null,
    olderMessages: [makeStoredMessage(1, 'user', 'Prefer technical history.')],
  };
  const append = () => {
    vi.mocked(runAgent).mockImplementation(async (input) => {
      const prompt = input.messages.at(-1)?.content ?? '';
      const relativePath = String(prompt).match(
        /memory\/\d{4}-\d{2}-\d{2}\.md/,
      )?.[0];
      if (!relativePath) throw new Error('Missing note path');
      const filePath = path.join(workspace, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const content = 'Prefer technical history.';
      const previous = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf8').trimEnd()
        : '';
      fs.writeFileSync(
        filePath,
        (previous ? previous + '\n\n' : '') + content + '\n',
      );
      return {
        status: 'success',
        result: 'Saved.',
        toolsUsed: ['memory'],
        toolExecutions: [
          {
            name: 'memory',
            arguments: JSON.stringify({
              action: 'append',
              file_path: relativePath,
              content,
            }),
            result: `Appended ${content.length} chars to ${relativePath}`,
            durationMs: 1,
          },
        ],
      };
    });
  };
  return {
    ...maintenance,
    params,
    workspace,
    runAgent: vi.mocked(runAgent),
    append,
  };
}

test('memory flush marks and notifies only after a real append', async () => {
  const { runPreCompactionMemoryFlush, params, append } = await prepareFlush();
  const notifyMemoryFlush = vi.fn();
  ensurePluginManagerInitializedMock.mockResolvedValue({ notifyMemoryFlush });
  append();
  await expect(runPreCompactionMemoryFlush(params)).resolves.toBe(true);
  expect(memoryServiceMock.markSessionMemoryFlush).toHaveBeenCalledWith(
    params.sessionId,
  );
  expect(notifyMemoryFlush).toHaveBeenCalledOnce();
});

test('unverified claims leave memory pending and prevent compaction', async () => {
  const { compactSessionNow, params, runAgent } = await prepareFlush();
  runAgent.mockResolvedValue({
    status: 'success',
    result: 'Saved.',
    toolsUsed: [],
  });
  memoryServiceMock.getSessionById.mockReturnValue({
    id: params.sessionId,
    session_summary: null,
  });
  memoryServiceMock.getRecentMessages.mockReturnValue([
    ...params.olderMessages,
    makeStoredMessage(2, 'user', 'Next request.'),
  ]);
  memoryServiceMock.getCompactionCandidateMessages.mockReturnValue({
    olderMessages: params.olderMessages,
    cutoffId: 2,
  });
  ensurePluginManagerInitializedMock.mockResolvedValue(null);
  await expect(compactSessionNow(params)).resolves.toBeNull();
  expect(memoryServiceMock.markSessionMemoryFlush).not.toHaveBeenCalled();
  expect(memoryServiceMock.compactSession).not.toHaveBeenCalled();
});

test('explicit skip completes maintenance without creating a note', async () => {
  const { runPreCompactionMemoryFlush, params, runAgent } =
    await prepareFlush();
  runAgent.mockResolvedValue({
    status: 'success',
    result: 'MEMORY_FLUSH_SKIPPED',
    toolsUsed: [],
  });
  ensurePluginManagerInitializedMock.mockResolvedValue(null);
  await expect(runPreCompactionMemoryFlush(params)).resolves.toBe(true);
  expect(memoryServiceMock.markSessionMemoryFlush).toHaveBeenCalledOnce();
});

test('a later batch failure leaves the flush pending', async () => {
  const { runPreCompactionMemoryFlush, params, runAgent, append } =
    await prepareFlush();
  append();
  const successful = runAgent.getMockImplementation();
  runAgent.mockImplementationOnce(successful!).mockResolvedValue({
    status: 'error',
    result: null,
    toolsUsed: [],
    error: 'Provider unavailable.',
  });
  params.olderMessages.push(makeStoredMessage(2, 'user', 'x'.repeat(8000)));
  await expect(runPreCompactionMemoryFlush(params)).resolves.toBe(false);
  expect(runAgent).toHaveBeenCalledTimes(2);
  expect(memoryServiceMock.markSessionMemoryFlush).not.toHaveBeenCalled();
});

test('all batches must verify before the flush is marked complete', async () => {
  const { runPreCompactionMemoryFlush, params, runAgent, append } =
    await prepareFlush();
  ensurePluginManagerInitializedMock.mockResolvedValue(null);
  append();
  params.olderMessages.push(makeStoredMessage(2, 'user', 'x'.repeat(8000)));
  await expect(runPreCompactionMemoryFlush(params)).resolves.toBe(true);
  expect(runAgent).toHaveBeenCalledTimes(3);
  expect(memoryServiceMock.markSessionMemoryFlush).toHaveBeenCalledOnce();
});

test('scoped flushes verify the scoped note and do not notify main-workspace memory plugins', async () => {
  const { runPreCompactionMemoryFlush, params, workspace, runAgent, append } =
    await prepareFlush();
  scopeRunMock.resolveScopeRun.mockResolvedValue({
    workspaceDir: workspace,
    agentId: 'main',
    scope: { id: 'research' },
    blockedTools: [],
  });
  scopeRunMock.scopeRunAgentParams.mockReturnValue({
    workspacePathOverride: workspace,
    runtimeScope: { agentId: 'main', scopeId: 'research' },
  });
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  vi.mocked(agentWorkspaceDir).mockReturnValue(makeTempDir());
  const notifyMemoryFlush = vi.fn();
  ensurePluginManagerInitializedMock.mockResolvedValue({ notifyMemoryFlush });
  append();
  await expect(runPreCompactionMemoryFlush(params)).resolves.toBe(true);
  expect(runAgent).toHaveBeenCalledWith(
    expect.objectContaining({ workspacePathOverride: workspace }),
  );
  expect(notifyMemoryFlush).not.toHaveBeenCalled();
});

test('a deleted scope cannot flush into the main workspace', async () => {
  const { runPreCompactionMemoryFlush, params, runAgent } =
    await prepareFlush();
  scopeRunMock.resolveScopeRun.mockResolvedValue({
    errorCode: 'scope_deleted',
  });
  await expect(runPreCompactionMemoryFlush(params)).resolves.toBe(false);
  expect(runAgent).not.toHaveBeenCalled();
  expect(memoryServiceMock.markSessionMemoryFlush).not.toHaveBeenCalled();
});

function mockCompactionCandidate(olderMessages: StoredMessage[]) {
  memoryServiceMock.getSessionById.mockReturnValue({
    id: 'session-1',
    session_summary: null,
  });
  memoryServiceMock.getRecentMessages.mockReturnValue([
    ...olderMessages,
    makeStoredMessage(2, 'user', 'Next request.'),
  ]);
  memoryServiceMock.getCompactionCandidateMessages.mockReturnValue({
    olderMessages,
    cutoffId: 2,
  });
  memoryServiceMock.compactSession.mockResolvedValue(makeResult());
  ensurePluginManagerInitializedMock.mockResolvedValue(null);
}

test('a full daily note compacts without spending a flush call', async () => {
  const { compactSessionNow, params, workspace, runAgent, append } =
    await prepareFlush();
  mockCompactionCandidate(params.olderMessages);
  append();

  await expect(compactSessionNow(params)).resolves.not.toBeNull();
  expect(runAgent).toHaveBeenCalledOnce();

  fs.writeFileSync(
    path.join(workspace, `memory/${currentDateStampInTimezone()}.md`),
    'x'.repeat(DAILY_MEMORY_MAX_CHARS),
  );
  await expect(compactSessionNow(params)).resolves.not.toBeNull();
  expect(runAgent).toHaveBeenCalledOnce();
  expect(memoryServiceMock.compactSession).toHaveBeenCalledTimes(2);
});

test('an append rejected for the note size does not block compaction', async () => {
  const { compactSessionNow, params, workspace, runAgent } =
    await prepareFlush();
  mockCompactionCandidate(params.olderMessages);
  const relativePath = `memory/${currentDateStampInTimezone()}.md`;
  fs.mkdirSync(path.join(workspace, 'memory'));
  fs.writeFileSync(path.join(workspace, relativePath), 'x'.repeat(20_000));
  runAgent.mockResolvedValue({
    status: 'success',
    result: 'The note is full.',
    toolsUsed: ['memory'],
    toolExecutions: [
      {
        name: 'memory',
        arguments: JSON.stringify({
          action: 'append',
          file_path: relativePath,
          content: 'y'.repeat(5_000),
        }),
        result: `Error: ${relativePath} would exceed ${DAILY_MEMORY_MAX_CHARS} chars. Shorten content or remove older entries first.`,
        durationMs: 1,
        isError: true,
      },
    ],
  });

  await expect(compactSessionNow(params)).resolves.not.toBeNull();
  expect(runAgent).toHaveBeenCalledOnce();
  expect(memoryServiceMock.compactSession).toHaveBeenCalledOnce();
});

test('the flush names today’s note in the user’s time zone', async () => {
  const { runPreCompactionMemoryFlush, params, workspace, runAgent, append } =
    await prepareFlush();
  ensurePluginManagerInitializedMock.mockResolvedValue(null);
  fs.writeFileSync(
    path.join(workspace, 'USER.md'),
    '- **Timezone:** Pacific/Kiritimati\n',
  );
  append();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T10:30:00Z'));
  try {
    await expect(runPreCompactionMemoryFlush(params)).resolves.toBe(true);
  } finally {
    vi.useRealTimers();
  }
  expect(String(runAgent.mock.calls[0][0].messages.at(-1)?.content)).toContain(
    'memory/2026-10-23.md',
  );
});
