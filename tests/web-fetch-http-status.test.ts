import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const { summarize } = vi.hoisted(() => ({ summarize: vi.fn() }));
vi.mock('../container/src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: summarize,
}));
useCleanMocks({ resetModules: true, unstubAllGlobals: true });
beforeEach(() => {
  summarize.mockReset().mockResolvedValue({ content: 'Synthetic summary.' });
});

const url = 'https://93.184.216.34/document';
const html =
  '<html><body><noscript>Enable JavaScript to read this document.</noscript><main><p>Synthetic diagnostic.</p></main></body></html>';

test.each([403, 404, 405, 429, 500, 302])(
  'HTTP %i retains diagnostics while all web tool modes report failure',
  async (status) => {
    const fetchMock = vi.fn(
      async () =>
        new Response(html, {
          status,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    for (const [tool, options] of [
      ['web_fetch', {}],
      ['web_fetch', { llmProcess: true }],
      ['web_extract', {}],
    ] as const) {
      const result = await executeToolWithMetadata(
        tool,
        JSON.stringify({ url, ...options }),
      );
      expect(result.output).toContain(url);
      expect(result.output).toContain(`HTTP ${status}`);
      expect(result.output).toContain('Escalation hint:');
      expect(result.output).toContain('Synthetic diagnostic.');
      expect(result.isError).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(summarize).not.toHaveBeenCalled();
  },
);

test('failed pages skip auxiliary processing even when its output looks successful', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(html, {
          status: 405,
          headers: { 'Content-Type': 'text/html' },
        }),
    ),
  );
  const { executeToolWithMetadata, executeTool } = await import(
    '../container/src/tools.js'
  );
  const args = JSON.stringify({ url, llmProcess: true });
  const result = await executeToolWithMetadata('web_extract', args);
  expect(summarize).not.toHaveBeenCalled();
  expect(result.output).not.toContain('Synthetic summary.');
  expect(await executeTool('web_extract', args)).toBe(result.output);
  expect(result.isError).toBe(true);
});

test.each([200, 202])(
  'HTTP %i still permits auxiliary extraction',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('Synthetic source.', {
            status,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    );
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      'web_extract',
      JSON.stringify({ url }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Synthetic summary.');
    expect(summarize).toHaveBeenCalledTimes(1);
  },
);

test('an empty HTTP 204 remains successful without auxiliary processing', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  const result = await executeToolWithMetadata(
    'web_extract',
    JSON.stringify({ url }),
  );
  expect(result.isError).toBe(false);
  expect(summarize).not.toHaveBeenCalled();
});

test('an HTTP 200 page with an extraction hint retains successful transport status', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(html, {
          headers: { 'Content-Type': 'text/html' },
        }),
    ),
  );
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  const result = await executeToolWithMetadata(
    'web_fetch',
    JSON.stringify({ url }),
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain('Escalation hint:');
  expect(summarize).not.toHaveBeenCalled();
});

test('auxiliary failure on HTTP 200 still returns the source as a successful fetch', async () => {
  summarize.mockRejectedValue(new Error('Synthetic auxiliary failure'));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('Synthetic source.', {
          headers: { 'Content-Type': 'text/plain' },
        }),
    ),
  );
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  const result = await executeToolWithMetadata(
    'web_extract',
    JSON.stringify({ url }),
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain('Synthetic source.');
  expect(result.output).toContain('Synthetic auxiliary failure');
  expect(summarize).toHaveBeenCalledTimes(1);
});
