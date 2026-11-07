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
    await expect(webFetch(request)).rejects.toBe(failure);
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
