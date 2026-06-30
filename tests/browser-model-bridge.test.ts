import WebSocket from 'ws';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_BROWSER_MODEL_BRIDGE_MODEL,
  type BrowserModelBridgeHandle,
  computeForcedToolPrefix,
  parseLiquidToolCalls,
  startBrowserModelBridge,
} from '../src/providers/browser-model-bridge.ts';

const BASH_TOOL = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a bash command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
};

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
    // Log panel is collapsed by default (a <details> with no `open` attribute).
    expect(page).toContain('<details class="panel log-panel">');
    expect(page).not.toContain('log-panel" open');
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
    expect(workerBody).toContain('normalizeTools');
    expect(workerBody).toContain('tools: normalizedTools');
    expect(workerBody).toContain('hybridclaw_debug_model_responses');
    expect(workerBody).toContain('Debug model request');
    expect(workerBody).toContain('Debug model response');
    expect(workerBody).toContain('promptText');
    expect(workerBody).toContain('tool_calls');
    expect(workerBody).toContain('tool_call_id');
    // Tool-call arguments must be parsed to an object so the native chat
    // template (which calls .items()) renders multi-turn histories instead of
    // falling back to a plain prompt.
    expect(workerBody).toContain('toToolCallArguments');
    expect(workerBody).toContain('Tool call format: call:<tool_name>{key:value}');
    expect(workerBody).toContain(
      'Liquid tool call format: <|tool_call_start|>[tools.<tool_name>(key=value)]<|tool_call_end|>',
    );
    expect(workerBody).toContain('return_full_text: false');
    expect(workerBody).toContain('errorToData');
    expect(workerBody).toContain('reportLoadProgress');
    expect(workerBody).toContain('Browser console error');
    expect(workerBody).toContain('Model load failed');
    expect(workerBody).toContain('transformersVersion');
    expect(workerBody).not.toContain('Try a smaller max token limit');
    expect(workerBody).not.toContain("info.status !== 'progress_total'");

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
    expect(workerRuntimeBody).toContain('Gemma4ForCausalLM');
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

  test('rejects unsupported Liquid WebGPU quantization', async () => {
    await expect(
      startBrowserModelBridge({
        host: '127.0.0.1',
        port: 0,
        model: 'LiquidAI/LFM2.5-230M-ONNX',
        device: 'webgpu',
        dtype: 'q8',
      }),
    ).rejects.toThrow(
      'LiquidAI LFM WebGPU models support only q4 or fp16 quantization, not q8.',
    );
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

  test('forces a tool-call prefix and parses the native tool call', async () => {
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
        messages: [
          { role: 'user', content: 'Print the result of `ls -la`' },
        ],
        tools: [BASH_TOOL],
      }),
    });

    const generate = await generateMessage;
    const request = generate.request as Record<string, unknown>;
    expect(request.force_assistant_prefix).toBe('<|tool_call_start|>[');

    const id = String(generate.id);
    // The worker echoes the forced prefix as the first delta, then the model's
    // own completion of the native Pythonic tool call.
    const content =
      '<|tool_call_start|>[bash(command="ls -la")]<|tool_call_end|>';
    ws.send(JSON.stringify({ type: 'complete', id, content, tokens: 8 }));

    const response = await responsePromise;
    const payload = (await response.json()) as {
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          tool_calls?: Array<{ function: { name: string; arguments: string } }>;
        };
      }>;
    };

    expect(response.status).toBe(200);
    const choice = payload.choices[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.tool_calls).toEqual([
      expect.objectContaining({
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls -la"}' },
      }),
    ]);
  });

  test('streams a forced tool call as OpenAI tool_calls deltas', async () => {
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
        messages: [{ role: 'user', content: 'Print `ls -la`' }],
        tools: [BASH_TOOL],
      }),
    });

    const generate = await generateMessage;
    const id = String(generate.id);
    // The worker streams the forced prefix as the first delta, then the model's
    // completion; the bridge buffers these and must not leak raw markup as text.
    ws.send(JSON.stringify({ type: 'delta', id, delta: '<|tool_call_start|>[' }));
    ws.send(
      JSON.stringify({
        type: 'delta',
        id,
        delta: 'bash(command="ls -la")]<|tool_call_end|>',
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'complete',
        id,
        content: '<|tool_call_start|>[bash(command="ls -la")]<|tool_call_end|>',
        tokens: 8,
      }),
    );

    const body = await (await responsePromise).text();
    expect(body).not.toContain('<|tool_call_start|>');
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"name":"bash"');
    expect(body).toContain('"arguments":"{\\"command\\":\\"ls -la\\"}"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('data: [DONE]');
  });

  test('does not force a tool call after a tool result', async () => {
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
        messages: [
          { role: 'user', content: 'Print `ls -la`' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'bash', arguments: '{"command":"ls -la"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'total 0' },
        ],
        tools: [BASH_TOOL],
      }),
    });

    const generate = await generateMessage;
    const request = generate.request as Record<string, unknown>;
    expect(request.force_assistant_prefix).toBeUndefined();

    const id = String(generate.id);
    ws.send(
      JSON.stringify({ type: 'complete', id, content: 'All done.', tokens: 2 }),
    );

    const response = await responsePromise;
    const payload = (await response.json()) as {
      choices: Array<{
        finish_reason: string;
        message: { content: string | null; tool_calls?: unknown };
      }>;
    };
    expect(payload.choices[0]?.finish_reason).toBe('stop');
    expect(payload.choices[0]?.message.content).toBe('All done.');
    expect(payload.choices[0]?.message.tool_calls).toBeUndefined();
  });
});

describe('computeForcedToolPrefix', () => {
  const LIQUID = DEFAULT_BROWSER_MODEL_BRIDGE_MODEL;

  test('forces on a user turn when tools are present', () => {
    expect(
      computeForcedToolPrefix(
        { tools: [BASH_TOOL], messages: [{ role: 'user', content: 'go' }] },
        LIQUID,
      ),
    ).toBe('<|tool_call_start|>[');
  });

  test('does not force without tools', () => {
    expect(
      computeForcedToolPrefix(
        { messages: [{ role: 'user', content: 'go' }] },
        LIQUID,
      ),
    ).toBe('');
  });

  test('does not force for non-Liquid model families', () => {
    expect(
      computeForcedToolPrefix(
        { tools: [BASH_TOOL], messages: [{ role: 'user', content: 'go' }] },
        'onnx-community/gemma-3-270m-ONNX',
      ),
    ).toBe('');
  });

  test('does not force after a tool result', () => {
    expect(
      computeForcedToolPrefix(
        {
          tools: [BASH_TOOL],
          messages: [
            { role: 'user', content: 'go' },
            { role: 'tool', tool_call_id: 'c', content: 'done' },
          ],
        },
        LIQUID,
      ),
    ).toBe('');
  });

  test('honors tool_choice required and none', () => {
    expect(
      computeForcedToolPrefix(
        {
          tools: [BASH_TOOL],
          tool_choice: 'required',
          messages: [{ role: 'tool', content: 'done' }],
        },
        LIQUID,
      ),
    ).toBe('<|tool_call_start|>[');
    expect(
      computeForcedToolPrefix(
        {
          tools: [BASH_TOOL],
          tool_choice: 'none',
          messages: [{ role: 'user', content: 'go' }],
        },
        LIQUID,
      ),
    ).toBe('');
  });

  test('forces a specific named function', () => {
    expect(
      computeForcedToolPrefix(
        {
          tools: [BASH_TOOL],
          tool_choice: { type: 'function', function: { name: 'bash' } },
          messages: [{ role: 'user', content: 'go' }],
        },
        LIQUID,
      ),
    ).toBe('<|tool_call_start|>[bash(');
  });
});

describe('parseLiquidToolCalls', () => {
  test('parses a single quoted-argument tool call', () => {
    const result = parseLiquidToolCalls(
      '<|tool_call_start|>[bash(command="ls -la")]<|tool_call_end|>',
    );
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls -la"}' },
      }),
    ]);
  });

  test('parses multiple calls and strips the tools. prefix', () => {
    const result = parseLiquidToolCalls(
      "<|tool_call_start|>[tools.bash(command='id'), get_weather(city='Paris', units=2)]<|tool_call_end|>",
    );
    expect(result.toolCalls.map((call) => call.function)).toEqual([
      { name: 'bash', arguments: '{"command":"id"}' },
      { name: 'get_weather', arguments: '{"city":"Paris","units":2}' },
    ]);
  });

  test('preserves surrounding prose and tolerates a missing end token', () => {
    const result = parseLiquidToolCalls(
      'Sure. <|tool_call_start|>[bash(command="pwd")]',
    );
    expect(result.content).toBe('Sure.');
    expect(result.toolCalls[0]?.function).toEqual({
      name: 'bash',
      arguments: '{"command":"pwd"}',
    });
  });

  test('returns text unchanged when there is no tool call', () => {
    const result = parseLiquidToolCalls('just a plain answer');
    expect(result.content).toBe('just a plain answer');
    expect(result.toolCalls).toEqual([]);
  });
});
