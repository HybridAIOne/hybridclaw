import { expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });

test('the real worker excludes commented text from large-page fallback output', async () => {
  const url = 'https://93.184.216.34/report';
  const preload = `const originalFetch = globalThis.fetch;
    const html = '<html><head><!-- <title>Discarded title</title> --><title>Field report</title></head><body><article><h1>Field report</h1><p>Visible article.</p><!-- <a href="/draft">Draft author</a> --></article><!--' + 'x'.repeat(1_000_001) + '--></body></html>';
    globalThis.fetch = (input, ...args) => String(input) === ${JSON.stringify(url)}
      ? Promise.resolve(new Response(html, {headers:{"Content-Type":"text/html"}}))
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
    expect(result?.content).toContain('Visible article.');
    expect(result?.content).not.toMatch(/Draft author|Discarded title|--!?>/);
    observed = true;
    return { role: 'assistant', content: 'The article is available.' };
  });
  expect(worker.output.status).toBe('success');
  expect(observed).toBe(true);
});
