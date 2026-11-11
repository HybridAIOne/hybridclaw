import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });

test('an expired input makes no model call and a later request gets its own context', async () => {
  const reply = vi.fn(async () => ({
    role: 'assistant',
    content: 'Fresh request completed.',
  }));
  const worker = await runAgent(reply, {
    executionDeadlineAtMs: Date.now() - 1,
  });
  expect(reply).not.toHaveBeenCalled();
  expect(worker.output.status).toBe('error');
  expect(worker.output.error).toContain('deadline exceeded');
  expect(worker.output.tokenUsage?.modelCalls).toBe(0);
  const next = await worker.followup({
    requestId: 'fresh',
    executionDeadlineAtMs: undefined,
    messages: [{ role: 'user', content: 'Read new synthetic notes.' }],
  });
  expect(next.status).toBe('success');
  expect(next.result).toBe('Fresh request completed.');
  expect(worker.requests).toHaveLength(1);
  expect(JSON.stringify(worker.requests[0])).not.toContain(
    'Runtime execution budget:',
  );
});

test('remaining-budget notes append without rewriting the prior model context or user request', async () => {
  let calls = 0;
  const worker = await runAgent(
    async () =>
      ++calls === 1
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'read',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: JSON.stringify({ path: 'notes.txt' }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'Completed.' },
    { executionDeadlineAtMs: Date.now() + 60_000 },
    { 'notes.txt': 'Synthetic source.' },
  );
  expect(worker.output.status).toBe('success');
  expect(worker.requests).toHaveLength(2);
  const [first, next] = worker.requests;
  expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
  expect(
    first.messages.some((m) =>
      String(m.content).includes('Runtime execution budget:'),
    ),
  ).toBe(true);
  expect(
    next.messages.filter((m) =>
      String(m.content).includes('Runtime execution budget:'),
    ),
  ).toHaveLength(2);
  expect(worker.output.effectiveUserPrompt).toBe('Read the synthetic notes');
});

test('expiry between sequential tools preserves the first artifact and blocks its deletion', async () => {
  const executionDeadlineAtMs = Date.now() + 60_000;
  const preload = `import fs from 'node:fs';
    const original = fs.linkSync, originalNow = Date.now;
    fs.linkSync = (from, to, ...args) => {
      const result = original(from, to, ...args);
      if (String(to).endsWith('/partial.svg')) {
        const offset = ${executionDeadlineAtMs} + 1 - originalNow();
        Date.now = () => originalNow() + offset;
      }
      return result;
    };`;
  vi.stubEnv(
    'NODE_OPTIONS',
    `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(preload)}`,
  );
  const worker = await runAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'partial',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({
                path: 'partial.svg',
                contents: '<svg xmlns="http://www.w3.org/2000/svg"/>',
              }),
            },
          },
          {
            id: 'too-late',
            type: 'function',
            function: {
              name: 'delete',
              arguments: JSON.stringify({ path: 'partial.svg' }),
            },
          },
        ],
      },
    ],
    { executionDeadlineAtMs, approvalMode: 'full' },
  );
  expect(worker.output.status).toBe('error');
  expect(worker.output.error).toContain('deadline exceeded');
  expect(worker.requests).toHaveLength(1);
  expect(worker.output.toolExecutions).toHaveLength(1);
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    name: 'write',
    isError: false,
  });
  expect(fs.existsSync(path.join(worker.dir, 'partial.svg'))).toBe(true);
  expect(
    worker.output.toolExecutions?.some((tool) => tool.name === 'delete'),
  ).toBe(false);
  expect(worker.output.artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ filename: 'partial.svg' }),
    ]),
  );
  expect(worker.output.tokenUsage?.modelCalls).toBe(1);
});

test('a late model reply retains usage while its proposed write never runs', async () => {
  const executionDeadlineAtMs = Date.now() + 60_000;
  const preload = `const originalFetch = globalThis.fetch, originalNow = Date.now;
    globalThis.fetch = async (input, ...args) => {
      const response = await originalFetch(input, ...args);
      if (!String(input).endsWith('/chat/completions')) return response;
      const body = await response.json();
      const offset = ${executionDeadlineAtMs} + 1 - originalNow();
      Date.now = () => originalNow() + offset;
      return new Response(JSON.stringify({...body, usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}), {status:200, headers:{'Content-Type':'application/json'}});
    };`;
  vi.stubEnv(
    'NODE_OPTIONS',
    `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(preload)}`,
  );
  const worker = await runAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'late-write',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({
                path: 'late.txt',
                contents: 'Must not run.',
              }),
            },
          },
        ],
      },
    ],
    { executionDeadlineAtMs, approvalMode: 'full' },
  );
  expect(worker.output.status).toBe('error');
  expect(worker.output.error).toContain('deadline exceeded');
  expect(worker.requests).toHaveLength(1);
  expect(worker.output.toolExecutions).toHaveLength(0);
  expect(fs.existsSync(path.join(worker.dir, 'late.txt'))).toBe(false);
  expect(worker.output.tokenUsage).toMatchObject({
    modelCalls: 1,
    apiUsageAvailable: true,
    apiPromptTokens: 7,
    apiCompletionTokens: 3,
    apiTotalTokens: 10,
  });
});

test.each(['retry', 'stream fallback'] as const)(
  'expiry prevents a new primary request during %s',
  async (phase) => {
    const deadline = Date.now() + 60_000;
    const preload = `const originalFetch = globalThis.fetch, originalNow = Date.now;
    globalThis.fetch = async (input, ...args) => {
      const response = await originalFetch(input, ...args);
      if (!String(input).endsWith('/chat/completions')) return response;
      const offset = ${deadline} + 1 - originalNow();
      Date.now = () => originalNow() + offset;
      return new Response(JSON.stringify({error:{message:'${phase === 'retry' ? 'Temporary overload' : 'stream is not supported'}'}}), {status:${phase === 'retry' ? 503 : 400}, headers:{'Content-Type':'application/json'}});
    };`;
    vi.stubEnv(
      'NODE_OPTIONS',
      `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(preload)}`,
    );
    vi.stubEnv('HYBRIDCLAW_RETRY_BASE_DELAY_MS', '100');
    vi.stubEnv('HYBRIDCLAW_RETRY_MAX_DELAY_MS', '100');
    const worker = await runAgent(
      [{ role: 'assistant', content: 'Unused response.' }],
      {
        executionDeadlineAtMs: deadline,
        provider: 'openrouter',
        model: 'openrouter/example/model',
        streamTextDeltas: phase === 'stream fallback',
      },
    );
    expect(worker.output.status).toBe('error');
    expect(worker.output.error).toContain('deadline exceeded');
    expect(worker.requests).toHaveLength(1);
  },
);
