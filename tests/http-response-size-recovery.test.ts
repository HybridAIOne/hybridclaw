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
