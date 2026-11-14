import { expect, test, vi } from 'vitest';
import { MAX_STALLED_MODEL_TURNS } from '../container/src/stalled-turns.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });

function stubPages() {
  const preload = `const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, ...args) => String(input).startsWith('https://93.184.216.34/')
      ? Promise.resolve(new Response(
          '<html><body><noscript>Enable JavaScript.</noscript><main><p>Synthetic page.</p></main></body></html>',
          {status: String(input).endsWith('/missing') ? 405 : 200, headers:{'Content-Type':'text/html'}}))
      : originalFetch(input, ...args);`;
  vi.stubEnv(
    'NODE_OPTIONS',
    `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(preload)}`,
  );
}

test.each(['web_fetch', 'web_extract'])(
  '%s HTTP failures allow recovery to a working URL without auxiliary calls',
  async (tool) => {
    stubPages();
    let calls = 0;
    const worker = await runAgent(async (body) => {
      if (calls > 0) {
        const receipt = body.messages.at(-1);
        expect(receipt?.role).toBe('tool');
        expect(receipt?.content).toContain('Synthetic page.');
        if (calls === 1) expect(receipt?.content).toContain('HTTP 405');
      }
      if (calls++ >= 2) return { role: 'assistant', content: 'Recovered.' };
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `page-${calls}`,
            type: 'function',
            function: {
              name: calls === 1 ? tool : 'web_fetch',
              arguments: JSON.stringify({
                url: `https://93.184.216.34/${calls === 1 ? 'missing' : 'working'}`,
              }),
            },
          },
        ],
      };
    });
    expect(worker.output.status).toBe('success');
    expect(worker.output.result).toBe('Recovered.');
    expect(worker.requests).toHaveLength(3);
    expect(
      worker.output.toolExecutions?.map(({ name, isError, blocked }) => ({
        name,
        isError,
        blocked: Boolean(blocked),
      })),
    ).toEqual([
      { name: tool, isError: true, blocked: false },
      { name: 'web_fetch', isError: false, blocked: false },
    ]);
  },
);

test('repeated failed HTTP fetches reach the existing stalled-turn boundary', async () => {
  stubPages();
  let calls = 0;
  const worker = await runAgent(
    async () => {
      if (calls++ >= MAX_STALLED_MODEL_TURNS)
        return { role: 'assistant', content: 'Unexpected continuation.' };
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `page-${calls}`,
            type: 'function',
            function: {
              name: 'web_fetch',
              arguments: JSON.stringify({
                url: 'https://93.184.216.34/missing',
              }),
            },
          },
        ],
      };
    },
    {},
    {},
    { timeoutMs: 20_000 },
  );
  expect(calls).toBe(MAX_STALLED_MODEL_TURNS);
  expect(worker.output.toolExecutions).toHaveLength(MAX_STALLED_MODEL_TURNS);
  expect(worker.output.toolExecutions?.every(({ isError }) => isError)).toBe(
    true,
  );
  expect(worker.output.result).toContain(
    `No successful tool progress for ${MAX_STALLED_MODEL_TURNS}`,
  );
}, 25_000);
