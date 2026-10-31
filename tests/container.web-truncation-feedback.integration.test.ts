import { expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });

test('source truncation stays visible when the real worker spills a long result', async () => {
  const url = 'https://93.184.216.34/report';
  const preload = `const originalFetch = globalThis.fetch;
    const body = 'SOURCE_BEGIN ' + 'observation '.repeat(6000) + ' SOURCE_END';
    globalThis.fetch = (input, ...args) => String(input) === ${JSON.stringify(url)}
      ? Promise.resolve(new Response(body, {headers:{"Content-Type":"text/plain"}}))
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
            function: {
              name: 'web_fetch',
              arguments: JSON.stringify({ url, maxChars: 100_000 }),
            },
          },
        ],
      };
    }
    const result = body.messages.at(-1);
    expect(result?.role).toBe('tool');
    const text = String(result?.content);
    expect(text).toContain('.tool-results/');
    expect(text.slice(0, text.indexOf('SOURCE_BEGIN'))).toMatch(/truncat/i);
    expect(text).toContain('SOURCE_BEGIN');
    expect(text).not.toContain('SOURCE_END');
    observed = true;
    return {
      role: 'assistant',
      content: 'The available source is incomplete.',
    };
  });
  expect(worker.output.status).toBe('success');
  expect(observed).toBe(true);
});
