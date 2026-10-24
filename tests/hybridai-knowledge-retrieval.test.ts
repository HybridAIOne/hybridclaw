import { expect, test, vi } from 'vitest';

import { callGatewayTool } from '../plugins/hybridai-knowledge/src/gateway-client.js';
import {
  buildMaintenancePrompt,
  msUntilNextRun,
  runMaintenance,
  startMaintenanceSchedule,
} from '../plugins/hybridai-knowledge/src/maintenance.js';
import {
  buildKnowledgeContext,
  latestUserQuery,
  searchKnowledge,
} from '../plugins/hybridai-knowledge/src/retrieval.js';

function message(role: string, content: string) {
  return {
    id: 1,
    session_id: 's',
    user_id: 'u',
    username: null,
    role,
    content,
    created_at: '2026-10-25T08:00:00.000Z',
  };
}

test('the latest user message is the query, trimmed and capped', () => {
  expect(
    latestUserQuery([
      message('user', ' first '),
      message('assistant', 'reply'),
      message('user', '  latest question  '),
    ]),
  ).toBe('latest question');
  expect(latestUserQuery([message('assistant', 'only replies')])).toBe('');
  expect(latestUserQuery([message('user', 'x'.repeat(3000))], 10)).toHaveLength(10);
});

test('searchKnowledge merges collections best first, drops duplicates and failures', async () => {
  const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    if (args.collection === 'Broken_1') throw new Error('gateway down');
    return {
      status: 'success',
      results: [
        {
          path: 'concepts/a.md',
          location: 'concepts/a.md#x',
          title: 'A',
          heading: 'A > X',
          score: args.collection === 'One_1' ? 0.5 : 0.9,
          content: `from ${String(args.collection)}`,
        },
        {
          path: 'concepts/a.md',
          location: 'concepts/a.md#x',
          title: 'A',
          score: args.collection === 'One_1' ? 0.7 : 0.4,
          content: 'duplicate of the same section, scored differently',
        },
      ],
    };
  });
  const errors: unknown[] = [];
  const hits = await searchKnowledge({
    query: 'q',
    collections: ['One_1', 'Broken_1', 'Two_1'],
    limit: 5,
    callTool,
    onError: (error) => errors.push(error),
  });
  expect(callTool).toHaveBeenCalledTimes(3);
  expect(errors).toHaveLength(1);
  // The best-scored occurrence of a section wins, whichever came first.
  expect(hits.map((hit) => [hit.collection, hit.score])).toEqual([
    ['Two_1', 0.9],
    ['One_1', 0.7],
  ]);

  await searchKnowledge({ query: 'q', collections: [], limit: 2, callTool });
  expect(callTool).toHaveBeenLastCalledWith('knowledge_search', { query: 'q', limit: 2 });
});

test('the context keeps the budget and tags every entry', () => {
  const hits = [
    {
      collection: 'C',
      location: 'concepts/a.md#x',
      title: 'A',
      heading: 'A > X',
      type: 'concept',
      score: 0.9,
      content: 'alpha '.repeat(40).trim(),
    },
    {
      collection: 'C',
      location: 'raw/b.md',
      title: 'B',
      heading: '',
      type: 'raw',
      score: 0.6,
      content: 'beta '.repeat(400).trim(),
    },
    {
      collection: 'C',
      location: 'concepts/c.md',
      title: 'C',
      heading: '',
      type: 'concept',
      score: 0.1,
      content: 'below the score floor',
    },
  ];
  const context = buildKnowledgeContext(hits, { maxInjectedChars: 600, minScore: 0.2 });
  expect(context).toContain('[knowledge: C/concepts/a.md#x] A > X');
  expect(context).not.toContain('[knowledge: C/raw/b.md]');
  expect(context).not.toContain('below the score floor');
  expect(context!.length).toBeLessThanOrEqual(600);
  expect(buildKnowledgeContext([], { maxInjectedChars: 600, minScore: 0.2 })).toBeNull();
});

test('callGatewayTool posts a tools/call and unwraps the text result', async () => {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://platform.example/api/v1/connectors/mcp');
    expect(JSON.parse(String(init.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'knowledge_search', arguments: { query: 'q', limit: 1 } },
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ status: 'success', results: [] }) }],
          isError: false,
        },
      }),
    } as unknown as Response;
  });
  const result = await callGatewayTool({
    baseUrl: 'https://platform.example/',
    apiKey: 'k',
    name: 'knowledge_search',
    args: { query: 'q', limit: 1 },
    timeoutMs: 1000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(result).toEqual({ status: 'success', results: [] });

  const failing = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'Knowledge collection not found.' }], isError: true },
        }),
      }) as unknown as Response,
  );
  await expect(
    callGatewayTool({
      baseUrl: 'https://platform.example',
      apiKey: 'k',
      name: 'knowledge_search',
      args: { query: 'q' },
      timeoutMs: 1000,
      fetchImpl: failing as unknown as typeof fetch,
    }),
  ).rejects.toThrow('Knowledge collection not found.');
});

test('maintenance runs daily at the configured hour on its own session', async () => {
  expect(msUntilNextRun(new Date('2026-10-25T02:00:00Z'), 3)).toBe(60 * 60 * 1000);
  expect(msUntilNextRun(new Date('2026-10-25T03:00:00Z'), 3)).toBe(24 * 60 * 60 * 1000);
  expect(buildMaintenancePrompt({ collection: 'Handbook_1' })).toContain('`Handbook_1`');
  expect(buildMaintenancePrompt({ collection: '' })).toContain('knowledge_list');

  const dispatch = vi.fn(async (request: { onToolProgress?: (e: unknown) => void }) => {
    for (let n = 0; n < 3; n += 1) {
      request.onToolProgress?.({
        sessionId: 's',
        toolName: 'hybridai__knowledge_write',
        phase: 'start',
      });
    }
    return { result: 'Merged two pages.' };
  });
  const api = {
    getDefaultAgentId: () => 'main',
    dispatchInboundMessage: dispatch,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  const config = {
    maintenance: { enabled: true, hourUtc: 3, agentId: '', collection: 'Handbook_1' },
  };
  const report = await runMaintenance({ api, config });
  expect(report).toBe('Merged two pages.');
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'knowledge-maintenance:main',
      channelId: 'knowledge-maintenance',
      agentId: 'main',
      sessionMode: 'resume',
      allowedTools: expect.arrayContaining(['hybridai__knowledge_write']),
    }),
  );
  expect(dispatch.mock.calls[0]?.[0].allowedTools).not.toContain('write_file');

  // The thirteenth write aborts the turn; the run still reports what it has.
  const runaway = vi.fn(async (request: { onToolProgress?: (e: unknown) => void; abortSignal?: AbortSignal }) => {
    for (let n = 0; n < 13; n += 1) {
      request.onToolProgress?.({
        sessionId: 's',
        toolName: 'hybridai__knowledge_write',
        phase: 'start',
      });
    }
    expect(request.abortSignal?.aborted).toBe(true);
    throw new Error('aborted');
  });
  const capped = await runMaintenance({
    api: { ...api, dispatchInboundMessage: runaway },
    config,
  });
  expect(capped).toBe('');
  expect(api.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ writes: 13 }),
    'Knowledge maintenance turn aborted: write budget exhausted',
  );

  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-25T02:59:00Z'));
    const run = vi.fn(async () => 'ok');
    const stop = startMaintenanceSchedule({ api, config, run });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
