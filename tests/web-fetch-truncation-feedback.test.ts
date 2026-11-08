import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ resetModules: true, unstubAllGlobals: true });
const url = 'https://93.184.216.34/report';

test.each(['web_fetch', 'web_extract'])(
  '%s identifies incomplete source content before the retained excerpt',
  async (name) => {
    const body = `SOURCE_BEGIN ${'observation '.repeat(30)} SOURCE_END`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    );
    const { executeTool } = await import('../container/src/tools.js');
    const output = await executeTool(
      name,
      JSON.stringify({
        url,
        maxChars: 100,
        llmProcess: false,
      }),
    );
    expect(output.slice(0, output.indexOf('SOURCE_BEGIN'))).toMatch(/truncat/i);
    expect(output).toContain(body.slice(0, 100));
    expect(output).not.toContain('SOURCE_END');
  },
);

test.each(['web_fetch', 'web_extract'])(
  '%s does not label a complete source as truncated',
  async (name) => {
    const body = 'SOURCE_BEGIN complete observation SOURCE_END';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    );
    const { executeTool } = await import('../container/src/tools.js');
    const output = await executeTool(
      name,
      JSON.stringify({
        url,
        maxChars: 100,
        llmProcess: false,
      }),
    );
    expect(output).toContain(body);
    expect(output.slice(0, output.indexOf('SOURCE_BEGIN'))).not.toMatch(
      /truncat/i,
    );
  },
);

test('cached excerpts retain their source truncation status', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(`SOURCE_BEGIN ${'observation '.repeat(30)} SOURCE_END`, {
        headers: { 'Content-Type': 'text/plain' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { executeTool } = await import('../container/src/tools.js');
  const args = JSON.stringify({ url, maxChars: 100 });
  await executeTool('web_fetch', args);
  const output = await executeTool('web_fetch', args);
  expect(output.slice(0, output.indexOf('SOURCE_BEGIN'))).toMatch(/truncat/i);
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('auxiliary summaries retain the source truncation warning', async () => {
  const summary = 'Summary of the available observations.';
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === url) {
        return new Response(
          `SOURCE_BEGIN ${'observation '.repeat(30)} SOURCE_END`,
          { headers: { 'Content-Type': 'text/plain' } },
        );
      }
      expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
      expect(init?.body).toContain('SOURCE_BEGIN');
      expect(init?.body).not.toContain('SOURCE_END');
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: summary } }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  const { setModelContext, setTaskModelPolicies } = await import(
    '../container/src/model-context.js'
  );
  setModelContext({
    provider: 'openrouter',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'test-model',
    chatbotId: '',
    requestHeaders: {},
  });
  setTaskModelPolicies({
    web_extract: {
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/test-model',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
    },
  });
  const { executeTool } = await import('../container/src/tools.js');
  const output = await executeTool(
    'web_extract',
    JSON.stringify({ url, maxChars: 100 }),
  );
  expect(output).toContain(summary);
  expect(output.slice(0, output.indexOf(summary))).toMatch(/truncat/i);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
