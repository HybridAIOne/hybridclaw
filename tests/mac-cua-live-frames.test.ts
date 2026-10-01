import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let workspace = '';

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-mac-cua-frames-'));
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function stubGateway(
  respond: (toolName: string) => Record<string, unknown>,
): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      bodies.push(body);
      return new Response(JSON.stringify(respond(body.toolName)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return bodies;
}

async function macCuaBrowserTools() {
  const tools = await import('../container/src/browser-tools.js');
  tools.setBrowserGatewayContext(
    'http://127.0.0.1:4317',
    'test-token',
    'mac-cua',
    'sess-mac',
    'main',
  );
  return tools;
}

const FRAME = {
  success: true,
  url: 'https://hybridai.one/admin_workspace?tab=credits',
  title: 'HybridAI',
  imageBase64: Buffer.from('jpeg-bytes').toString('base64'),
};

function frameLines(stderr: ReturnType<typeof vi.spyOn>) {
  return stderr.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('[browser-frame] '))
    .map((line) => JSON.parse(line.slice('[browser-frame] '.length)));
}

test('a mac-cua click is followed by a live frame of the Safari window', async () => {
  const bodies = stubGateway((toolName) =>
    toolName === 'browser_frame' ? FRAME : { success: true, text: 'Dashboard' },
  );
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { executeBrowserTool } = await macCuaBrowserTools();

  const result = JSON.parse(
    await executeBrowserTool('browser_click', { text: 'Dashboard' }, 'chat'),
  );

  expect(result).toMatchObject({ success: true, provider: 'mac-cua' });
  expect(bodies.map((body) => [body.toolName, body.args])).toEqual([
    ['browser_click', { text: 'Dashboard' }],
    ['browser_frame', { image: true }],
  ]);
  const [line] = frameLines(stderr);
  // The query string never reaches the client.
  expect(line).toMatchObject({
    url: 'https://hybridai.one/admin_workspace',
    title: 'HybridAI',
  });
  expect(
    fs.readFileSync(path.join(workspace, line.frame), 'utf8'),
  ).toBe('jpeg-bytes');
});

test('a mac-cua frame is dropped while a typed secret is on the page', async () => {
  stubGateway((toolName) =>
    toolName === 'browser_frame' ? FRAME : { success: true },
  );
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { executeBrowserTool } = await macCuaBrowserTools();
  const { pauseBrowserFramesUntilNavigation } = await import(
    '../container/src/browser-checkout.js'
  );

  await executeBrowserTool('browser_click', { text: 'Sign in' }, 'chat');
  pauseBrowserFramesUntilNavigation();
  await executeBrowserTool('browser_click', { text: 'Continue' }, 'chat');

  const lines = frameLines(stderr);
  expect(lines).toHaveLength(2);
  expect(lines[1]).not.toHaveProperty('frame');
  expect(
    fs.readdirSync(path.join(workspace, '.browser-artifacts', 'frames')),
  ).toHaveLength(1);
});

test('a mac-cua snapshot feeds its refs to the checkout guard, not the model', async () => {
  stubGateway((toolName) =>
    toolName === 'browser_snapshot'
      ? {
          success: true,
          url: 'https://shop.example/checkout',
          title: 'Checkout',
          snapshot: '- button "Jetzt kaufen" [ref=e12]',
          refs: { e12: { role: 'button', name: 'Jetzt kaufen' } },
        }
      : { success: true },
  );
  const { executeBrowserTool } = await macCuaBrowserTools();
  const { classifyBrowserCheckout } = await import(
    '../container/src/browser-checkout.js'
  );

  const result = JSON.parse(
    await executeBrowserTool('browser_snapshot', {}, 'chat'),
  );

  expect(result).not.toHaveProperty('refs');
  expect(result.snapshot).toContain('[ref=e12]');
  expect(classifyBrowserCheckout('browser_click', { ref: '@e12' })).toEqual({
    host: 'shop.example',
    label: 'Jetzt kaufen',
    url: 'https://shop.example/checkout',
  });
});
