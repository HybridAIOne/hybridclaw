import { expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });

test('main-page status reaches the next model request through the real worker', async () => {
  const url = 'https://93.184.216.34/status';
  const discussion = 'A detailed discussion of implementation choices and allocation behavior. '.repeat(30);
  const html = `<html><head><title>Ticket summary</title></head><body><main><div class="page-header"><h1>Ticket summary</h1><span>Archived without release</span></div><article><p>${discussion}</p><p>${discussion}</p></article></main></body></html>`;
  const preload = `const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, ...args) => String(input) === ${JSON.stringify(url)}
      ? Promise.resolve(new Response(${JSON.stringify(html)}, {headers:{"Content-Type":"text/html"}}))
      : originalFetch(input, ...args);`;
  vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(preload)}`);
  let first = true;
  let observed = false;
  const worker = await runAgent(async body => {
    if (first) {
      first = false;
      return { role: 'assistant', content: null, tool_calls: [{ id: 'fetch-page', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url }) } }] };
    }
    const result = body.messages?.at(-1);
    expect(result?.role).toBe('tool');
    expect(result?.content).toContain('Archived without release');
    expect(result?.content).toContain('allocation behavior');
    observed = true;
    return { role: 'assistant', content: 'The page is archived.' };
  }, { approvalMode: 'full' });
  expect(worker.output.status).toBe('success');
  expect(observed).toBe(true);
});
