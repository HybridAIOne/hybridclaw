import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('hybridclaw-http-pdf-handoff-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

test('a gateway-downloaded PDF can be read from its returned alias in a separate host workspace', async () => {
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', temp());
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const state = agentWorkspaceDir('main');
  fs.mkdirSync(state, { recursive: true });
  fs.symlinkSync(path.resolve('skills'), path.join(state, 'skills'), 'dir');
  const execution = temp();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', execution);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', execution);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', state);
  vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', JSON.stringify([state]));
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Downloaded document evidence.');
  const bytes = await pdf.save();
  const fetchMock = vi.fn(
    async () =>
      new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const req = Object.assign(
    Readable.from([
      JSON.stringify({
        url: 'https://93.184.216.34/paper.pdf',
        method: 'GET',
        responseArtifact: {},
        maxResponseBytes: bytes.length,
        agentId: 'main',
      }),
    ]),
    { method: 'POST', headers: { 'content-type': 'application/json' } },
  ) as unknown as IncomingMessage;
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    setHeader() {},
    end(value: string) {
      body = String(value);
    },
  } as unknown as ServerResponse;
  const { handleApiHttpRequest } = await import(
    '../src/gateway/gateway-http-proxy.js'
  );
  await handleApiHttpRequest(req, res);
  expect(status).toBe(200);
  const result = JSON.parse(body);
  expect(result).toMatchObject({
    bodySuppressed: true,
    bodyBytes: bytes.length,
  });
  const { executeToolWithMetadata, setMediaContext } = await import(
    '../container/src/tools.js'
  );
  setMediaContext([], [], true);
  const read = await executeToolWithMetadata(
    'read',
    JSON.stringify({ path: result.artifact.path, render: 'never' }),
  );
  expect(read.isError, read.output).toBe(false);
  expect(JSON.parse(read.output)).toMatchObject({
    pageCount: 1,
    processedPages: [1],
    pages: [
      {
        page: 1,
        text: expect.stringContaining('Downloaded document evidence.'),
      },
    ],
  });
  expect(fs.readdirSync(execution)).toEqual([]);
  expect(fetchMock).toHaveBeenCalledOnce();
});
