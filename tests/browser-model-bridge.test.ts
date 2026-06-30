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

async function startTestBridge(
  options: { apiKey?: string } = {},
): Promise<BrowserModelBridgeHandle> {
  const handle = await startBrowserModelBridge({
    host: '127.0.0.1',
    port: 0,
    model: DEFAULT_BROWSER_MODEL_BRIDGE_MODEL,
    device: 'wasm',
    dtype: 'q4',
    apiKey: options.apiKey,
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
    expect(body.length).toBeGreaterThan(1000);
    expect(body).toContain('pipeline');
  });

  test('serves browser runtime import map dependencies', async () => {
    const handle = await startTestBridge();

    const pageResponse = await fetch(handle.pageUrl);
    const page = await pageResponse.text();
    expect(pageResponse.headers.get('cross-origin-opener-policy')).toBe(
      'same-origin',
    );
    expect(pageResponse.headers.get('cross-origin-embedder-policy')).toBe(
      'require-corp',
    );
    expect(page).toContain('"onnxruntime-common": "/vendor/onnxruntime-common/index.js"');
    expect(page).toContain('"onnxruntime-web": "/vendor/onnxruntime-web.js"');
    expect(page).toContain("new Worker('/bridge/worker.js'");
    expect(page).toContain('progress.is-generating::-webkit-progress-value');
    expect(page).toContain(
      "progressEl.classList.toggle('is-generating', state === 'generating')",
    );

    const workerResponse = await fetch(`${handle.pageUrl}bridge/worker.js`);
    const workerBody = await workerResponse.text();
    expect(workerResponse.status).toBe(200);
    expect(workerResponse.headers.get('content-type')).toContain(
      'text/javascript',
    );
    expect(workerResponse.headers.get('cross-origin-embedder-policy')).toBe(
      'require-corp',
    );
    expect(workerBody).toContain("import('/vendor/transformers.worker.js')");
    expect(workerBody).toContain('apply_chat_template');
    expect(workerBody).toContain('return_full_text: false');
    expect(workerBody).toContain('errorToData');
    expect(workerBody).not.toContain('Try a smaller max token limit');

    const workerRuntimeResponse = await fetch(
      `${handle.pageUrl}vendor/transformers.worker.js`,
    );
    const workerRuntimeBody = await workerRuntimeResponse.text();
    expect(workerRuntimeResponse.status).toBe(200);
    expect(workerRuntimeResponse.headers.get('content-type')).toContain(
      'text/javascript',
    );
    expect(workerRuntimeBody).toContain(
      'from "/vendor/onnxruntime-common/index.js";',
    );
    expect(workerRuntimeBody).toContain('from "/vendor/onnxruntime-web.js";');
    expect(workerRuntimeBody).not.toContain('from "onnxruntime-common";');
    expect(workerRuntimeBody).not.toContain('from "onnxruntime-web";');
    expect(workerRuntimeBody).not.toContain('from "onnxruntime-web/webgpu";');

    const webResponse = await fetch(`${handle.pageUrl}vendor/onnxruntime-web.js`);
    const webBody = await webResponse.text();
    expect(webResponse.status).toBe(200);
    expect(webResponse.headers.get('content-type')).toContain(
      'text/javascript',
    );
    expect(webBody).toContain('ONNX Runtime Web');

    const wasmLoaderResponse = await fetch(
      `${handle.pageUrl}vendor/ort-wasm-simd-threaded.jsep.mjs`,
    );
    expect(wasmLoaderResponse.status).toBe(200);
    expect(wasmLoaderResponse.headers.get('content-type')).toContain(
      'text/javascript',
    );
    expect(wasmLoaderResponse.headers.get('cross-origin-resource-policy')).toBe(
      'same-origin',
    );

    const asyncifyLoaderResponse = await fetch(
      `${handle.pageUrl}vendor/ort-wasm-simd-threaded.asyncify.mjs`,
    );
    expect(asyncifyLoaderResponse.status).toBe(200);
    expect(asyncifyLoaderResponse.headers.get('content-type')).toContain(
      'text/javascript',
    );

    const asyncifyWasmResponse = await fetch(
      `${handle.pageUrl}vendor/ort-wasm-simd-threaded.asyncify.wasm`,
    );
    expect(asyncifyWasmResponse.status).toBe(200);
    expect(asyncifyWasmResponse.headers.get('content-type')).toBe(
      'application/wasm',
    );

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

  test('rejects malformed bearer authorization without regex backtracking', async () => {
    const handle = await startTestBridge({ apiKey: 'test-key' });

    const response = await fetch(`${handle.endpointUrl}/models`, {
      headers: {
        Authorization: `bearer\t${'\t\t'.repeat(512)}`,
      },
    });
    const payload = (await response.json()) as {
      error?: { message?: string; type?: string };
    };

    expect(response.status).toBe(401);
    expect(payload.error).toMatchObject({
      message: 'Unauthorized',
      type: 'authentication_error',
    });
  });

  test('returns a generic request body error for oversized chat requests', async () => {
    const handle = await startTestBridge();
    const ws = await connectFakeBrowser(handle);
    handles.push({
      ...handle,
      close: async () => {
        ws.close();
      },
    });

    const response = await fetch(`${handle.endpointUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: 'x'.repeat(2 * 1024 * 1024),
          },
        ],
      }),
    });
    const payload = (await response.json()) as {
      error?: { message?: string; type?: string };
    };

    expect(response.status).toBe(413);
    expect(payload.error).toMatchObject({
      message: 'Request body is too large.',
      type: 'invalid_request_error',
    });
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

  test('streams browser disconnects as provider errors', async () => {
    const handle = await startTestBridge();
    const ws = await connectFakeBrowser(handle);
    handles.push({
      ...handle,
      close: async () => {
        ws.close();
      },
    });

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
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    await generateMessage;
    ws.close();

    const response = await responsePromise;
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"error"');
    expect(body).toContain(
      '"message":"Browser tab disconnected before generation completed."',
    );
    expect(body).not.toContain(
      '"delta":{"content":"Browser tab disconnected before generation completed."}',
    );
  });
});
