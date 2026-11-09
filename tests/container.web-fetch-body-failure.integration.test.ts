import { expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });

test('the worker delivers body failure details to the model and tool receipt', async () => {
  const url = 'https://93.184.216.34/guide';
  const preload = `const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, ...args) => String(input) === ${JSON.stringify(url)}
      ? Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            const cause = Object.assign(new Error('incorrect header check'), {code:'Z_DATA_ERROR'});
            controller.error(new TypeError('terminated', {cause}));
          }
        }), {status:404, headers:{'Content-Type':'text/html','Content-Encoding':'gzip'}}))
      : originalFetch(input, ...args);`;
  vi.stubEnv(
    'NODE_OPTIONS',
    `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(preload)}`,
  );
  let first = true;
  let observed = false;
  const worker = await runAgent(async (body) => {
    if (first) {
      first = false;
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'fetch-page',
            type: 'function',
            function: { name: 'web_fetch', arguments: JSON.stringify({ url }) },
          },
        ],
      };
    }
    const result = body.messages.at(-1);
    expect(result?.role).toBe('tool');
    expect(result?.content).toMatch(
      /HTTP 404.*terminated.*incorrect header check.*Z_DATA_ERROR/,
    );
    observed = true;
    return { role: 'assistant', content: 'The response could not be decoded.' };
  });
  expect(worker.output.status).toBe('success');
  expect(observed).toBe(true);
  expect(worker.output.toolExecutions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'web_fetch', isError: true }),
    ]),
  );
});
