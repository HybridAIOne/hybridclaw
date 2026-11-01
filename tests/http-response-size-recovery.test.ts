import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, expect, test, vi } from 'vitest';
import { HTTP_RESPONSE_ARTIFACT_DIR } from '../container/shared/http-response-artifacts.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('http-size-recovery-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});
beforeEach(() => vi.stubEnv('HYBRIDCLAW_DATA_DIR', temp()));

async function request(options: Record<string, unknown>) {
  const req = Object.assign(
    Readable.from([
      JSON.stringify({ url: 'https://93.184.216.34/file.bin', ...options }),
    ]),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    },
  ) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    setHeader() {},
    end(value: string) {
      text = String(value);
    },
  } as unknown as ServerResponse;
  const { handleApiHttpRequest } = await import(
    '../src/gateway/gateway-http-proxy.js'
  );
  await handleApiHttpRequest(req, res);
  return { status, body: JSON.parse(text) };
}

test.each([false, true])(
  'oversized declared responses release the body (artifact: %s)',
  async (artifact) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': '64' },
    });
    const read = vi.spyOn(response.body!, 'getReader');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const pending = request({
      maxResponseBytes: 16,
      ...(artifact ? { responseArtifact: {} } : {}),
    });
    if (artifact) {
      await expect(pending).rejects.toThrow(/maxResponseBytes.*16.*64.*Retry/s);
      const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
      expect(
        fs.existsSync(
          path.join(agentWorkspaceDir('main'), HTTP_RESPONSE_ARTIFACT_DIR),
        ),
      ).toBe(false);
    } else {
      expect(await pending).toMatchObject({
        status: 200,
        body: {
          body: '',
          bodyTruncated: true,
          bodyBytes: 64,
          maxResponseBytes: 16,
        },
      });
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  },
);

test('an unknown-length oversized artifact cancels after the bounded read', async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(32));
            },
            cancel,
          }),
        ),
    ),
  );
  await expect(
    request({ maxResponseBytes: 16, responseArtifact: {} }),
  ).rejects.toThrow(/maxResponseBytes.*16.*32.*Retry/s);
  expect(cancel).toHaveBeenCalledOnce();
});

test('a caller can explicitly retry with a sufficient limit and save the whole artifact', async () => {
  const bytes = new Uint8Array(64).fill(65);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(bytes, {
          headers: { 'content-length': String(bytes.length) },
        }),
    ),
  );
  const result = await request({
    maxResponseBytes: bytes.length,
    responseArtifact: {},
  });
  expect(result).toMatchObject({
    status: 200,
    body: {
      success: true,
      bodySuppressed: true,
      bodyBytes: bytes.length,
      artifact: { filename: expect.any(String), sha256: expect.any(String) },
    },
  });
  expect(result.body).not.toHaveProperty('body');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const saved = path.join(
    agentWorkspaceDir('main'),
    HTTP_RESPONSE_ARTIFACT_DIR,
    path.basename(result.body.artifact.path),
  );
  expect(fs.readFileSync(saved)).toEqual(Buffer.from(bytes));
});

test('raising the response limit cannot bypass the private-network guard', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    request({
      url: 'http://127.0.0.1/file.bin',
      maxResponseBytes: 64,
      responseArtifact: {},
    }),
  ).rejects.toThrow(/SSRF/);
  expect(fetch).not.toHaveBeenCalled();
});

test.each([false, true])(
  'the deadline includes a stalled response body (artifact: %s)',
  async (artifact) => {
    let signal: AbortSignal | undefined;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let fetched: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      fetched = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        signal = init.signal ?? undefined;
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(new Uint8Array([65]));
              signal?.addEventListener(
                'abort',
                () => controller.error(signal?.reason),
                { once: true },
              );
            },
          }),
        );
        fetched?.();
        return response;
      }),
    );
    vi.useFakeTimers();
    const outcome = request({
      timeoutMs: 20,
      ...(artifact ? { responseArtifact: {} } : {}),
    }).then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      await ready;
      await vi.advanceTimersByTimeAsync(20);
      expect(signal?.aborted).toBe(true);
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
      expect(
        fs.existsSync(
          path.join(agentWorkspaceDir('main'), HTTP_RESPONSE_ARTIFACT_DIR),
        ),
      ).toBe(false);
    } finally {
      if (!signal?.aborted) stream?.close();
      await outcome;
      vi.useRealTimers();
    }
  },
);

test.each([
  'complete',
  'fetch-failure',
  'body-failure',
  'size-rejection',
  'suppressed',
  'redirect',
])('clears the deadline after %s', async (mode) => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init: RequestInit) => {
      signal = init.signal ?? undefined;
      if (mode === 'fetch-failure') throw new Error('upstream unavailable');
      if (mode === 'body-failure')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('body unavailable'));
            },
          }),
        );
      if (mode === 'redirect')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/redirect' },
        });
      return new Response('payload', { headers: { 'content-length': '7' } });
    }),
  );
  vi.useFakeTimers();
  try {
    const pending = request({
      timeoutMs: 20,
      ...(mode === 'size-rejection'
        ? { maxResponseBytes: 1, responseArtifact: {} }
        : {}),
      ...(mode === 'suppressed' ? { suppressResponseBody: true } : {}),
    });
    if (mode === 'complete' || mode === 'suppressed')
      expect(await pending).toMatchObject({ status: 200 });
    else await expect(pending).rejects.toThrow();
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(signal?.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
