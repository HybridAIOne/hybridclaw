import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { MAX_STALLED_MODEL_TURNS } from '../container/src/stalled-turns.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });

function readFile(call: number, filename = 'absent.txt') {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `read-${call}`,
        type: 'function',
        function: {
          name: 'read',
          arguments: JSON.stringify({ path: filename }),
        },
      },
    ],
  };
}

test.each([
  { provider: 'mlx' as const, isLocal: true, model: 'mlx/test' },
  { provider: 'openrouter' as const, isLocal: false, model: 'openrouter/test' },
])(
  '$provider reports stalled-turn exhaustion as an error',
  async (provider) => {
    let calls = 0;
    const worker = await runAgent(
      async () => {
        if (calls++ >= MAX_STALLED_MODEL_TURNS)
          return { role: 'assistant', content: 'Unexpected continuation.' };
        return readFile(calls);
      },
      provider,
      {},
      { timeoutMs: 20_000 },
    );
    expect(calls).toBe(MAX_STALLED_MODEL_TURNS);
    expect(worker.output.toolExecutions).toHaveLength(MAX_STALLED_MODEL_TURNS);
    expect(worker.output.toolExecutions?.every(({ isError }) => isError)).toBe(
      true,
    );
    expect(worker.output.status).toBe('error');
    expect(worker.output.error).toContain('No successful tool progress');
    expect(worker.output.outputPresentation?.segmentKind).toBe('status');
    expect(worker.output.tokenUsage?.modelCalls).toBe(calls);
  },
);

test('stalled output retains a completed artifact, measured usage and a reusable worker', async () => {
  const preload = `const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, ...args) => {
      const response = await originalFetch(input, ...args);
      if (!String(input).endsWith('/chat/completions')) return response;
      return new Response(JSON.stringify({...await response.json(), usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}),
        {status:response.status, headers:{'Content-Type':'application/json'}});
    };`;
  vi.stubEnv(
    'NODE_OPTIONS',
    `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(preload)}`,
  );
  const artifact =
    '<svg xmlns="http://www.w3.org/2000/svg"><text>Partial work</text></svg>';
  let calls = 0;
  const worker = await runAgent(
    async () => {
      calls++;
      if (calls === 1)
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'partial-artifact',
              type: 'function',
              function: {
                name: 'write',
                arguments: JSON.stringify({
                  path: 'partial.svg',
                  contents: artifact,
                }),
              },
            },
          ],
        };
      if (calls > MAX_STALLED_MODEL_TURNS + 1)
        return { role: 'assistant', content: 'Recovered on follow-up.' };
      return readFile(calls);
    },
    {},
    {},
    { timeoutMs: 20_000 },
  );
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    name: 'write',
    isError: false,
  });
  expect(worker.output.toolExecutions).toHaveLength(
    MAX_STALLED_MODEL_TURNS + 1,
  );
  expect(fs.readFileSync(path.join(worker.dir, 'partial.svg'), 'utf8')).toBe(
    artifact,
  );
  expect(worker.output.artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        filename: 'partial.svg',
        mimeType: 'image/svg+xml',
      }),
    ]),
  );
  expect(worker.output.tokenUsage).toMatchObject({
    modelCalls: calls,
    apiUsageAvailable: true,
    apiPromptTokens: calls * 7,
    apiCompletionTokens: calls * 3,
    apiTotalTokens: calls * 10,
  });
  expect(worker.output.status).toBe('error');
  expect(worker.output.error).toContain('No successful tool progress');
  const next = await worker.followup({
    requestId: 'after-stall',
    messages: [{ role: 'user', content: 'Resume with a final reply.' }],
  });
  expect(next.status).toBe('success');
  expect(next.result).toBe('Recovered on follow-up.');
  expect(next.error).toBeUndefined();
  expect(next.tokenUsage?.modelCalls).toBe(1);
});

test('successful tools reset the consecutive failure counter', async () => {
  let calls = 0;
  const worker = await runAgent(
    async () => {
      calls++;
      if (calls === MAX_STALLED_MODEL_TURNS * 2)
        return { role: 'assistant', content: 'Completed after recovery.' };
      return readFile(
        calls,
        calls === MAX_STALLED_MODEL_TURNS ? 'available.txt' : 'absent.txt',
      );
    },
    {},
    { 'available.txt': 'Synthetic reference.' },
    { timeoutMs: 20_000 },
  );
  expect(calls).toBe(MAX_STALLED_MODEL_TURNS * 2);
  expect(worker.output.status).toBe('success');
  expect(worker.output.error).toBeUndefined();
  expect(worker.output.result).toBe('Completed after recovery.');
});

test('a final answer after the last permitted failed turn remains successful', async () => {
  let calls = 0;
  const worker = await runAgent(async () =>
    ++calls === MAX_STALLED_MODEL_TURNS
      ? { role: 'assistant', content: 'The source is unavailable.' }
      : readFile(calls),
  );
  expect(calls).toBe(MAX_STALLED_MODEL_TURNS);
  expect(worker.output.status).toBe('success');
  expect(worker.output.error).toBeUndefined();
  expect(worker.output.result).toBe('The source is unavailable.');
});

test('the configured Ralph iteration cap still stops before the stalled-turn limit', async () => {
  const worker = await runAgent(
    async () => ({
      role: 'assistant',
      content: 'Continue the draft. <choice>CONTINUE</choice>',
    }),
    { ralphMaxIterations: 1 },
  );
  expect(worker.requests).toHaveLength(2);
  expect(worker.output.status).toBe('success');
  expect(worker.output.error).toBeUndefined();
});
