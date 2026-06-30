import WebSocket from 'ws';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_BROWSER_MODEL_BRIDGE_MODEL,
  type BrowserModelBridgeHandle,
  startBrowserModelBridge,
} from '../src/providers/browser-model-bridge.ts';

const handles: BrowserModelBridgeHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function startTestBridge(): Promise<BrowserModelBridgeHandle> {
  const handle = await startBrowserModelBridge({
    host: '127.0.0.1',
    port: 0,
    model: DEFAULT_BROWSER_MODEL_BRIDGE_MODEL,
    device: 'wasm',
    dtype: 'q4',
  });
  handles.push(handle);
  return handle;
}

function connectFakeBrowser(handle: BrowserModelBridgeHandle): Promise<WebSocket> {
  const wsUrl = handle.pageUrl.replace(/^http:/, 'ws:') + 'bridge/ws';
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('browser model bridge', () => {
  test('lists the configured browser model', async () => {
    const handle = await startTestBridge();

    const response = await fetch(`${handle.endpointUrl}/models`);
    const payload = (await response.json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.data).toEqual([
      expect.objectContaining({
        id: DEFAULT_BROWSER_MODEL_BRIDGE_MODEL,
        owned_by: 'browser',
      }),
    ]);
  });

  test('serves the Transformers.js browser asset', async () => {
    const handle = await startTestBridge();

    const response = await fetch(`${handle.pageUrl}vendor/transformers.web.js`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(body).toContain('Transformers.js');
  });

  test('serves browser runtime import map dependencies', async () => {
    const handle = await startTestBridge();

    const pageResponse = await fetch(handle.pageUrl);
    const page = await pageResponse.text();
    expect(page).toContain('"onnxruntime-common": "/vendor/onnxruntime-common/index.js"');
    expect(page).toContain('"onnxruntime-web": "/vendor/onnxruntime-web.js"');
    expect(page).toContain("import('/vendor/transformers.web.js')");

    const webResponse = await fetch(`${handle.pageUrl}vendor/onnxruntime-web.js`);
    const webBody = await webResponse.text();
    expect(webResponse.status).toBe(200);
    expect(webResponse.headers.get('content-type')).toContain(
      'text/javascript',
    );
    expect(webBody).toContain('ONNX Runtime Web');

    const commonResponse = await fetch(
      `${handle.pageUrl}vendor/onnxruntime-common/index.js`,
    );
    const commonBody = await commonResponse.text();
    expect(commonResponse.status).toBe(200);
    expect(commonResponse.headers.get('content-type')).toContain(
      'text/javascript',
    );
    expect(commonBody).toContain('ONNX Runtime JavaScript API');
  });

  test('returns 503 for chat requests until a browser tab connects', async () => {
    const handle = await startTestBridge();

    const response = await fetch(`${handle.endpointUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_BROWSER_MODEL_BRIDGE_MODEL,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const payload = (await response.json()) as { error?: { type?: string } };

    expect(response.status).toBe(503);
    expect(payload.error?.type).toBe('browser_bridge_unavailable');
  });

  test('relays chat completions through the connected browser tab', async () => {
    const handle = await startTestBridge();
    const ws = await connectFakeBrowser(handle);
    handles.push({
      ...handle,
      close: async () => {
        ws.close();
      },
    });

    const generated = 'hello from webgpu';
    const generateMessage = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (raw) => {
        const payload = JSON.parse(String(raw)) as Record<string, unknown>;
        if (payload.type === 'generate') resolve(payload);
      });
    });

    const responsePromise = fetch(`${handle.endpointUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_BROWSER_MODEL_BRIDGE_MODEL,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const generate = await generateMessage;
    expect(generate).toMatchObject({
      type: 'generate',
      request: expect.objectContaining({
        model: DEFAULT_BROWSER_MODEL_BRIDGE_MODEL,
      }),
    });
    const id = String(generate.id);
    ws.send(JSON.stringify({ type: 'delta', id, delta: generated }));
    ws.send(
      JSON.stringify({ type: 'complete', id, content: generated, tokens: 3 }),
    );

    const response = await responsePromise;
    const payload = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    expect(response.status).toBe(200);
    expect(payload.choices[0]?.message.content).toBe(generated);
  });
});
