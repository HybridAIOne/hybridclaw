import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const { runAgentMock, stopSessionHostProcessMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  stopSessionHostProcessMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: stopSessionHostProcessMock,
}));

const ORIGINAL_HOME = process.env.HOME;
const makeTempHome = useTempDir('hybridclaw-delegation-home-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  resetModules: true,
  cleanup: () => {
    restoreEnvVar('HOME', ORIGINAL_HOME);
    runAgentMock.mockReset();
    stopSessionHostProcessMock.mockReset();
  },
});

test('delegation batch queues status updates and a synthesized final answer for local channels', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  runAgentMock.mockImplementation(
    async (params: {
      messages?: unknown[];
      model?: string;
      onTextDelta?: (delta: string) => void;
      onToolProgress?: (event: {
        sessionId: string;
        toolName: string;
        phase: 'start' | 'finish';
        preview?: string;
        durationMs?: number;
      }) => void;
    }) => {
      const userMessage = params.messages?.find(
        (message): message is { role: string; content: string } =>
          Boolean(message) &&
          typeof message === 'object' &&
          (message as { role?: unknown }).role === 'user' &&
          typeof (message as { content?: unknown }).content === 'string',
      );
      const content = userMessage?.content || '';
      if (content.includes('Delegated results:')) {
        params.onTextDelta?.('final synthesized ');
        params.onTextDelta?.('comparison');
        return {
          status: 'success',
          result: 'final synthesized comparison',
          toolsUsed: [],
          artifacts: [],
        };
      }
      const targetUrl = content.includes('furukama')
        ? 'https://furukama.com'
        : 'https://hybridai.one';
      const searchQuery = content.includes('furukama')
        ? 'furukama.com branding'
        : 'hybridai.one company positioning';
      params.onToolProgress?.({
        sessionId: 'child-session',
        toolName: 'web_search',
        phase: 'start',
        preview: JSON.stringify({ query: searchQuery, provider: 'auto' }),
      });
      params.onToolProgress?.({
        sessionId: 'child-session',
        toolName: 'web_search',
        phase: 'finish',
        durationMs: 20,
      });
      params.onToolProgress?.({
        sessionId: 'child-session',
        toolName: 'web_fetch',
        phase: 'start',
        preview: JSON.stringify({ url: targetUrl }),
      });
      params.onToolProgress?.({
        sessionId: 'child-session',
        toolName: 'web_fetch',
        phase: 'finish',
        durationMs: 25,
      });
      return {
        status: 'success',
        result: content.includes('furukama')
          ? 'furukama child summary'
          : 'hybridai child summary',
        toolsUsed: ['web_search'],
        tokenUsage: {
          modelCalls: 1,
          apiUsageAvailable: true,
          apiPromptTokens: content.includes('furukama') ? 1200 : 1400,
          apiCompletionTokens: content.includes('furukama') ? 220 : 260,
          apiTotalTokens: content.includes('furukama') ? 1420 : 1660,
          apiCacheUsageAvailable: false,
          apiCacheReadTokens: 0,
          apiCacheWriteTokens: 0,
          estimatedPromptTokens: 0,
          estimatedCompletionTokens: 0,
          estimatedTotalTokens: 0,
        },
        toolExecutions: [
          {
            name: 'web_search',
            arguments: JSON.stringify({
              query: searchQuery,
              provider: 'auto',
              count: 5,
            }),
            result: JSON.stringify({
              results: [
                {
                  title: content.includes('furukama')
                    ? 'Furukama'
                    : 'HybridAI',
                  url: targetUrl,
                  snippet: 'Top result snippet',
                },
              ],
            }),
            durationMs: 20,
          },
        ],
        artifacts: [],
      };
    },
  );

  const { enqueueDelegationBatchFromSideEffects, normalizeDelegationEffect } =
    await import('../src/gateway/gateway-service.ts');
  const {
    getRecentStructuredAuditForSession,
    claimQueuedProactiveMessages,
    initDatabase,
    listQueuedProactiveMessages,
  } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  initDatabase({
    quiet: true,
    dbPath: path.join(homeDir, 'hybridclaw.db'),
  });
  updateRuntimeConfig((draft) => {
    draft.proactive.delegation.model = 'llamacpp/liquidai/lfm';
  });
  const furukamaPlan = normalizeDelegationEffect(
    {
      mode: 'single',
      label: 'furukama-branding-research',
      prompt: 'Research furukama.com branding.',
    },
    'orchestrator-model',
  ).plan;
  const hybridaiPlan = normalizeDelegationEffect(
    {
      mode: 'single',
      label: 'hybridai-one-research',
      prompt: 'Research hybridai.one.',
    },
    'orchestrator-model',
  ).plan;
  expect(furukamaPlan?.tasks[0]?.model).toBe('llamacpp/liquidai/lfm');
  expect(hybridaiPlan?.tasks[0]?.model).toBe('llamacpp/liquidai/lfm');

  enqueueDelegationBatchFromSideEffects({
    plans: [furukamaPlan!, hybridaiPlan!],
    parentSessionId: 'parent-session',
    channelId: 'tui',
    chatbotId: 'test-bot',
    enableRag: false,
    agentId: 'test-agent',
    parentModel: 'orchestrator-model',
    parentDepth: 0,
    parentPrompt: 'Summarize furukama.com and hybridai.one.',
    parentResult: 'I will synthesize after delegates return.',
  });

  await vi.waitFor(() => {
    const messages = listQueuedProactiveMessages(100).filter(
      (message) => message.channel_id === 'tui',
    );
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(
      messages.some((message) =>
        message.text.includes(
          'running web_search hybridai.one company positioning',
        ),
      ),
    ).toBe(true);
    expect(
      messages.some((message) =>
        message.text.includes('running web_fetch https://hybridai.one'),
      ),
    ).toBe(true);
  });

  const messages = claimQueuedProactiveMessages('tui', 100);
  expect(messages.length).toBeGreaterThanOrEqual(3);
  expect(
    messages.every(
      (message) =>
        message.source === 'delegate' ||
        message.source.startsWith('delegate:stream:'),
    ),
  ).toBe(true);
  expect(messages[0]?.text).toContain('[Delegate Status]');
  expect(messages[0]?.text).toContain(
    'Running 2 delegate jobs (llamacpp/liquidai/lfm)',
  );
  expect(messages[0]?.text).not.toContain('ctrl+o');
  expect(messages[0]?.text).toContain('Research furukama.com branding');
  expect(messages[0]?.text).toContain('Research hybridai.one');
  expect(
    messages.some((message) =>
      message.text.includes('running web_search furukama.com branding'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes('thinking after web_search furukama.com branding'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes(
        'running web_search hybridai.one company positioning',
      ),
    ),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes(
        'thinking after web_search hybridai.one company positioning',
      ),
    ),
  ).toBe(true);
  expect(
    messages.some((message) => message.text.includes('web_search auto')),
  ).toBe(false);
  expect(
    messages.some((message) =>
      message.text.includes('web_search search the web via auto'),
    ),
  ).toBe(false);
  expect(
    messages.some((message) =>
      message.text.includes('running web_fetch https://furukama.com'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes('thinking after web_fetch https://furukama.com'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes('running web_fetch https://hybridai.one'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) =>
      message.text.includes('thinking after web_fetch https://hybridai.one'),
    ),
  ).toBe(true);
  const finishedStatus = messages.find((message) =>
    message.text.includes('2 delegate jobs finished'),
  );
  expect(finishedStatus?.text).toContain('2 delegate jobs finished');
  expect(finishedStatus?.text).toContain(
    '2 delegate jobs finished (llamacpp/liquidai/lfm)',
  );
  expect(finishedStatus?.text).not.toContain('ctrl+o');
  expect(finishedStatus?.text).toContain('├ Research furukama.com branding');
  expect(finishedStatus?.text).toContain('└ Research hybridai.one');
  expect(finishedStatus?.text).toContain('1.4k tokens');
  expect(finishedStatus?.text).toContain('1.7k tokens');
  expect(finishedStatus?.text).toContain('Done');
  expect(
    messages.some((message) => message.source === 'delegate:stream:start'),
  ).toBe(true);
  expect(
    messages.some(
      (message) =>
        message.source === 'delegate:stream:delta' &&
        message.text.includes('final synthesized comparison'),
    ),
  ).toBe(true);
  expect(
    messages.some((message) => message.source === 'delegate:stream:end'),
  ).toBe(true);
  expect(
    messages.some(
      (message) =>
        message.source === 'delegate' &&
        message.text.includes('final synthesized comparison'),
    ),
  ).toBe(false);
  expect(runAgentMock).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      model: 'llamacpp/liquidai/lfm',
    }),
  );
  expect(runAgentMock).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      model: 'llamacpp/liquidai/lfm',
    }),
  );
  expect(runAgentMock).toHaveBeenLastCalledWith(
    expect.objectContaining({
      model: 'orchestrator-model',
    }),
  );

  const inspect = new Database(path.join(homeDir, 'hybridclaw.db'), {
    readonly: true,
  });
  const childRows = inspect
    .prepare(
      `SELECT session_id, messages_json, tool_executions_json
       FROM request_log
       WHERE session_id LIKE 'delegate:d1:parent-session:%'
       ORDER BY id ASC`,
    )
    .all() as Array<{
    session_id: string;
    messages_json: string | null;
    tool_executions_json: string | null;
  }>;
  inspect.close();

  expect(childRows).toHaveLength(2);
  const parsedChildRows = childRows.map((row) => ({
    session_id: row.session_id,
    messages: JSON.parse(row.messages_json || '[]') as Array<{
      role?: string;
      content?: string;
    }>,
    toolExecutions: JSON.parse(row.tool_executions_json || '[]') as Array<{
      name?: string;
      arguments?: string;
    }>,
  }));
  const furukamaRow = parsedChildRows.find((row) =>
    row.toolExecutions.some((execution) => {
      if (execution.name !== 'web_search') return false;
      const args = JSON.parse(execution.arguments || '{}') as {
        query?: string;
      };
      return args.query === 'furukama.com branding';
    }),
  );
  const hybridaiRow = parsedChildRows.find((row) =>
    row.toolExecutions.some((execution) => {
      if (execution.name !== 'web_search') return false;
      const args = JSON.parse(execution.arguments || '{}') as {
        query?: string;
      };
      return args.query === 'hybridai.one company positioning';
    }),
  );
  expect(furukamaRow?.toolExecutions[0]?.name).toBe('web_search');
  expect(hybridaiRow?.toolExecutions[0]?.name).toBe('web_search');
  const furukamaSystemPrompt =
    furukamaRow?.messages.find((message) => message.role === 'system')
      ?.content || '';
  const furukamaUserPrompt =
    furukamaRow?.messages.find((message) => message.role === 'user')?.content ||
    '';
  expect(furukamaSystemPrompt).not.toContain('Delegation mode:');
  expect(furukamaSystemPrompt).not.toContain('Current delegation depth:');
  expect(furukamaUserPrompt).toContain('# Delegated Task');
  expect(furukamaUserPrompt).toContain('Delegation mode: single.');
  expect(furukamaUserPrompt).toContain('Current delegation depth: 1.');
  expect(furukamaUserPrompt).toContain('Research furukama.com branding.');

  const furukamaAudit = getRecentStructuredAuditForSession(
    furukamaRow?.session_id || '',
    10,
  );
  expect(furukamaAudit.map((event) => event.event_type)).toContain('tool.call');
  expect(furukamaAudit.map((event) => event.event_type)).toContain(
    'tool.result',
  );
  expect(furukamaAudit.map((event) => event.event_type)).toContain(
    'model.usage',
  );
});

test('delegation prefers configured delegate model over echoed parent-model overrides', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  const { normalizeDelegationEffect } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  initDatabase({
    quiet: true,
    dbPath: path.join(homeDir, 'hybridclaw.db'),
  });
  updateRuntimeConfig((draft) => {
    draft.proactive.delegation.model =
      'llamacpp/unsloth/LFM2.5-1.2B-Instruct-GGUF';
  });

  const plan = normalizeDelegationEffect(
    {
      mode: 'parallel',
      model: 'gpt-5.4-mini',
      tasks: [
        {
          prompt: 'Inspect the first target.',
        },
        {
          prompt: 'Inspect the second target.',
          model: 'hybridai/gpt-5.4-mini',
        },
      ],
    },
    'hybridai/gpt-5.4-mini',
  ).plan;

  expect(plan?.tasks).toEqual([
    {
      prompt: 'Inspect the first target.',
      model: 'llamacpp/unsloth/LFM2.5-1.2B-Instruct-GGUF',
    },
    {
      prompt: 'Inspect the second target.',
      model: 'llamacpp/unsloth/LFM2.5-1.2B-Instruct-GGUF',
    },
  ]);
});

test('delegation status tracks duplicate task titles independently', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'child summary',
    toolsUsed: [],
    artifacts: [],
  });

  const { enqueueDelegationBatchFromSideEffects } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { initDatabase, listQueuedProactiveMessages } = await import(
    '../src/memory/db.ts'
  );
  initDatabase({
    quiet: true,
    dbPath: path.join(homeDir, 'hybridclaw.db'),
  });

  enqueueDelegationBatchFromSideEffects({
    plans: [
      {
        mode: 'single',
        label: 'duplicate',
        tasks: [
          {
            prompt: 'Handle the same displayed task.',
            label: 'duplicate',
            model: 'test-model',
          },
        ],
      },
      {
        mode: 'single',
        label: 'duplicate',
        tasks: [
          {
            prompt: 'Handle the same displayed task differently.',
            label: 'duplicate',
            model: 'test-model',
          },
        ],
      },
    ],
    parentSessionId: 'duplicate-parent-session',
    channelId: 'tui',
    chatbotId: 'test-bot',
    enableRag: false,
    agentId: 'test-agent',
    parentModel: 'orchestrator-model',
    parentDepth: 0,
  });

  await vi.waitFor(() => {
    const messages = listQueuedProactiveMessages(20).filter(
      (message) => message.channel_id === 'tui',
    );
    expect(
      messages.some((message) =>
        message.text.includes('2 delegate jobs finished'),
      ),
    ).toBe(true);
  });
});
