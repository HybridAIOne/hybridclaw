import { expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });

test('the real worker preserves section boundaries in fetched content', async () => {
  const url = 'https://93.184.216.34/guide';
  const paragraph =
    'The field notes describe the recorded observations and the method used to collect them. '.repeat(
      12,
    );
  const html = `<html><head><title>Field guide</title></head><body><article><h1>Field guide</h1><div><h2>Notes</h2><span>[<a href="?edit=1">Edit</a>]</span></div><p>${paragraph}</p><div><h2>Data</h2><span>[<a href="?edit=2">Edit</a>]</span></div><p>${paragraph}</p></article></body></html>`;
  const preload = `const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, ...args) => String(input) === ${JSON.stringify(url)}
      ? Promise.resolve(new Response(${JSON.stringify(html)}, {headers:{"Content-Type":"text/html"}}))
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
    expect(result?.content).toContain('## Notes');
    expect(result?.content).toContain('## Data');
    observed = true;
    return {
      role: 'assistant',
      content: 'The source has two labeled sections.',
    };
  });
  expect(worker.output.status).toBe('success');
  expect(observed).toBe(true);
});
