import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ resetModules: true, unstubAllGlobals: true });
const url = 'https://93.184.216.34/document';

test.each([
  {
    type: 'application/pdf',
    bytes: new TextEncoder().encode('%PDF-1.5\nprivate binary payload'),
  },
  {
    type: 'APPLICATION/PDF; charset=binary',
    bytes: new TextEncoder().encode('%PDF-1.5\nprivate binary payload'),
  },
  { type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0, 1]) },
  {
    type: 'application/octet-stream',
    bytes: new TextEncoder().encode('%PDF-1.5\nprivate binary payload'),
  },
  { type: 'application/zip', bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]) },
])(
  'binary $type yields an existing download route rather than text',
  async ({ type, bytes }) => {
    const fetchMock = vi.fn(
      async () => new Response(bytes, { headers: { 'Content-Type': type } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { webFetch } = await import('../container/src/web-fetch.js');
    const error = await webFetch({ url }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain('private binary payload');
    expect(JSON.parse(message.slice(message.indexOf('{')))).toEqual({
      name: 'http_request',
      arguments: { method: 'GET', url, responseArtifact: {} },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

test.each([
  { type: 'text/plain', body: 'Ordinary readable text.' },
  {
    type: 'application/octet-stream',
    body: 'A text download with an imprecise content type.',
  },
  {
    type: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg"><text>Label</text></svg>',
  },
  { type: 'application/json', body: '{"value":"\\u0000"}' },
])('readable $type stays available', async ({ type, body }) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(body, { headers: { 'Content-Type': type } }),
    ),
  );
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url });
  expect(result.status).toBe(200);
  expect(result.text).toBe(
    type === 'application/json'
      ? JSON.stringify(JSON.parse(body), null, 2)
      : body,
  );
});

test('web_extract never sends raw PDF bytes to an auxiliary model', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response('%PDF-1.5\nprivate binary payload', {
        headers: { 'Content-Type': 'application/pdf' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  const result = await executeToolWithMetadata(
    'web_extract',
    JSON.stringify({ url }),
  );
  expect(result.isError).toBe(true);
  expect(result.output).not.toContain('private binary payload');
  expect(result.output).toContain('responseArtifact');
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('a declared PDF cancels its unread body and reports the size needed for a bounded download', async () => {
  const response = new Response(new Uint8Array(2_000_001), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Length': '2000001' },
  });
  const cancel = vi.spyOn(response.body!, 'cancel');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  const { webFetch } = await import('../container/src/web-fetch.js');
  const error = await webFetch({ url }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('2000001');
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.bodyUsed).toBe(true);
});

test('the download continuation names the validated final URL after redirects', async () => {
  const final = 'https://1.1.1.1/Paper.PDF?token=PageA';
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: final } }),
    )
    .mockResolvedValueOnce(
      new Response('%PDF-1.5', {
        headers: { 'Content-Type': 'application/pdf' },
      }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const { webFetch } = await import('../container/src/web-fetch.js');
  const error = await webFetch({ url }).catch((error: unknown) => error);
  const message = (error as Error).message;
  expect(JSON.parse(message.slice(message.indexOf('{'))).arguments.url).toBe(
    final,
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
