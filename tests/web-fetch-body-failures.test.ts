import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ resetModules: true, unstubAllGlobals: true });

test.each([
  {
    name: 'partial text',
    contentType: 'text/plain',
    prefix: 'partial document',
  },
  {
    name: 'partial JSON',
    contentType: 'application/json',
    prefix: '{"incomplete":',
  },
  { name: 'no body bytes', contentType: 'text/plain', prefix: '' },
])(
  'rejects $name after a transport failure and leaves the URL retryable',
  async ({ contentType, prefix }) => {
    const failure = new Error('connection lost');
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (prefix && !delivered) {
          delivered = true;
          controller.enqueue(new TextEncoder().encode(prefix));
        } else {
          controller.error(failure);
        }
      },
    });
    const complete =
      contentType === 'application/json'
        ? '{"complete":true}'
        : 'complete document';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(stream, { headers: { 'Content-Type': contentType } }),
      )
      .mockResolvedValueOnce(
        new Response(complete, { headers: { 'Content-Type': contentType } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { webFetch } = await import('../container/src/web-fetch.js');
    const request = { url: 'https://93.184.216.34/document' };
    await expect(webFetch(request)).rejects.toMatchObject({
      message: expect.stringMatching(/HTTP 200.*connection lost/),
      cause: failure,
    });
    const retry = await webFetch(request);
    expect(retry.text).toBe(
      contentType === 'application/json'
        ? JSON.stringify({ complete: true }, null, 2)
        : complete,
    );
    expect(retry.cached).not.toBe(true);
    expect(retry.truncated).toBe(false);
    expect(await webFetch(request)).toMatchObject({ ...retry, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

test.each(['web_fetch', 'web_extract'])(
  '%s exposes HTTP status and decompression cause without response payloads',
  async (tool) => {
    const cause = Object.assign(new Error('incorrect header check'), {
      code: 'Z_DATA_ERROR',
      privateDiagnostic: 'internal-detail',
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('terminated', { cause }));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(stream, {
            status: 404,
            headers: {
              'Content-Type': 'text/html',
              'Content-Encoding': 'gzip',
              'Set-Cookie': 'session=test-cookie',
            },
          }),
      ),
    );
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      tool,
      JSON.stringify({
        url: 'https://93.184.216.34/missing',
        llmProcess: false,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('HTTP 404');
    expect(result.output).toContain('terminated');
    expect(result.output).toContain('incorrect header check');
    expect(result.output).toContain('Z_DATA_ERROR');
    expect(result.output).not.toMatch(/test-cookie|internal-detail/);
  },
);

test('reports non-streaming body failures and terminates cyclic error causes', async () => {
  const failure = new Error('body unavailable');
  failure.cause = failure;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: 502,
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      text: async () => {
        throw failure;
      },
    })),
  );
  const { webFetch } = await import('../container/src/web-fetch.js');
  await expect(
    webFetch({ url: 'https://93.184.216.34/document' }),
  ).rejects.toMatchObject({
    message: expect.stringMatching(/HTTP 502.*body unavailable/),
    cause: failure,
  });
});
