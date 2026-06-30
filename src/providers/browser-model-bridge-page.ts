import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function textResponse(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function getTransformersDistPath(fileName: string): string {
  const entryPoint = require.resolve('@huggingface/transformers');
  return path.join(path.dirname(entryPoint), fileName);
}

function getPackageRoot(packageName: string): string {
  let dir = path.dirname(require.resolve(packageName));
  while (dir !== path.dirname(dir)) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as { name?: string };
      if (parsed.name === packageName) return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not resolve package root for ${packageName}.`);
}

function resolveBrowserBridgeAssetPath(vendorPath: string): string | null {
  let assetPath: string;
  try {
    assetPath = decodeURIComponent(vendorPath).replace(/^\/vendor\/+/u, '');
  } catch {
    return null;
  }
  if (
    !assetPath ||
    assetPath.includes('..') ||
    assetPath.includes('\\') ||
    path.isAbsolute(assetPath)
  ) {
    return null;
  }

  const transformersAssets = new Set([
    'transformers.web.js',
    'transformers.web.min.js',
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
  ]);
  if (transformersAssets.has(assetPath)) {
    return getTransformersDistPath(assetPath);
  }
  if (assetPath === 'onnxruntime-web.js') {
    return path.join(
      getPackageRoot('onnxruntime-web'),
      'dist',
      'ort.webgpu.bundle.min.mjs',
    );
  }

  const commonPrefix = 'onnxruntime-common/';
  if (!assetPath.startsWith(commonPrefix)) return null;
  const relativePath = assetPath.slice(commonPrefix.length);
  if (!relativePath.endsWith('.js') && !relativePath.endsWith('.map')) {
    return null;
  }
  const basePath = path.join(
    getPackageRoot('onnxruntime-common'),
    'dist',
    'esm',
  );
  const filePath = path.resolve(basePath, relativePath);
  if (!filePath.startsWith(`${basePath}${path.sep}`)) return null;
  return filePath;
}

export function serveBrowserBridgeAsset(
  res: ServerResponse,
  vendorPath: string,
): void {
  const filePath = resolveBrowserBridgeAssetPath(vendorPath);
  if (!filePath) {
    textResponse(res, 404, 'Not found');
    return;
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    textResponse(res, 404, 'Not found');
    return;
  }
  if (!stat.isFile()) {
    textResponse(res, 404, 'Not found');
    return;
  }
  res.statusCode = 200;
  if (filePath.endsWith('.wasm')) {
    res.setHeader('content-type', 'application/wasm');
  } else if (filePath.endsWith('.map')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
  } else {
    res.setHeader('content-type', 'text/javascript; charset=utf-8');
  }
  res.setHeader('content-length', stat.size);
  createReadStream(filePath).pipe(res);
}

export function buildBrowserBridgeHtml(config: {
  model: string;
  device: string;
  dtype: string;
  maxNewTokens: number;
}): string {
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HybridClaw Browser Model Bridge</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #101113;
      color: #f4f4f5;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #101113;
    }
    main {
      width: min(760px, calc(100vw - 32px));
      display: grid;
      gap: 18px;
    }
    h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .panel {
      border: 1px solid #30343a;
      border-radius: 8px;
      padding: 18px;
      background: #181a1f;
      display: grid;
      gap: 12px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      border-bottom: 1px solid #2a2e35;
      padding-bottom: 10px;
    }
    .row:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .label {
      color: #a1a1aa;
      font-size: 13px;
    }
    .value {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      text-align: right;
      overflow-wrap: anywhere;
    }
    progress {
      width: 100%;
      height: 12px;
      accent-color: #5eead4;
    }
    .log {
      min-height: 140px;
      max-height: 260px;
      overflow: auto;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #d4d4d8;
    }
  </style>
</head>
<body>
  <main>
    <h1>HybridClaw Browser Model Bridge</h1>
    <section class="panel">
      <div class="row"><span class="label">Model</span><span class="value" id="model"></span></div>
      <div class="row"><span class="label">Device</span><span class="value" id="device"></span></div>
      <div class="row"><span class="label">Bridge</span><span class="value" id="bridge">connecting</span></div>
      <div class="row"><span class="label">Runtime</span><span class="value" id="runtime">idle</span></div>
      <progress id="progress" max="100" value="0"></progress>
    </section>
    <section class="panel">
      <div class="log" id="log"></div>
    </section>
  </main>
  <script type="importmap">
    {
      "imports": {
        "onnxruntime-common": "/vendor/onnxruntime-common/index.js",
        "onnxruntime-web": "/vendor/onnxruntime-web.js"
      }
    }
  </script>
  <script type="module">
    const CONFIG = ${configJson};
    const modelEl = document.getElementById('model');
    const deviceEl = document.getElementById('device');
    const bridgeEl = document.getElementById('bridge');
    const runtimeEl = document.getElementById('runtime');
    const progressEl = document.getElementById('progress');
    const logEl = document.getElementById('log');

    modelEl.textContent = CONFIG.model;
    deviceEl.textContent = CONFIG.device + ' / ' + CONFIG.dtype;

    let socket;
    let generatorPromise = null;
    let transformersPromise = null;
    let transformersRuntime = null;
    let busy = false;
    let queue = Promise.resolve();

    function log(message) {
      const stamp = new Date().toLocaleTimeString();
      logEl.textContent += '[' + stamp + '] ' + message + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
    }

    window.addEventListener('error', (event) => {
      log('Page error: ' + (event.message || String(event.error || 'unknown error')));
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      log('Unhandled rejection: ' + (reason instanceof Error ? reason.message : String(reason || 'unknown error')));
    });

    function setRuntime(state, message, progress) {
      runtimeEl.textContent = message || state;
      if (typeof progress === 'number' && Number.isFinite(progress)) {
        progressEl.value = Math.max(0, Math.min(100, progress));
      }
      send({
        type: 'status',
        state,
        message: message || state,
        progress: progressEl.value
      });
    }

    function send(payload) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(payload));
    }

    async function loadTransformersRuntime() {
      if (transformersRuntime) return transformersRuntime;
      if (!transformersPromise) {
        setRuntime('loading', 'loading Transformers.js runtime', 0);
        log('Loading Transformers.js runtime');
        transformersPromise = import('/vendor/transformers.web.js')
          .then((runtime) => {
            if (
              !runtime.pipeline ||
              !runtime.TextStreamer ||
              !runtime.InterruptableStoppingCriteria ||
              !runtime.env
            ) {
              throw new Error('Transformers.js browser runtime is missing expected exports.');
            }
            runtime.env.backends.onnx.wasm.wasmPaths = '/vendor/';
            transformersRuntime = {
              pipeline: runtime.pipeline,
              TextStreamer: runtime.TextStreamer,
              stoppingCriteria: new runtime.InterruptableStoppingCriteria()
            };
            log('Transformers.js runtime loaded');
            setRuntime('idle', 'idle', progressEl.value);
            return transformersRuntime;
          })
          .catch((error) => {
            transformersPromise = null;
            const message = error instanceof Error ? error.message : String(error);
            setRuntime('error', 'runtime import failed: ' + message, progressEl.value);
            log('Transformers.js runtime failed: ' + message);
            throw error;
          });
      }
      return transformersPromise;
    }

    function connect() {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      log('Opening WebSocket ' + scheme + '//' + location.host + '/bridge/ws');
      socket = new WebSocket(scheme + '//' + location.host + '/bridge/ws');
      const connectTimer = setTimeout(() => {
        if (socket && socket.readyState === WebSocket.CONNECTING) {
          log('WebSocket still connecting after 5s');
        }
      }, 5000);

      socket.addEventListener('open', () => {
        clearTimeout(connectTimer);
        bridgeEl.textContent = 'connected';
        log('Connected to local OpenAI bridge');
        send({
          type: 'hello',
          model: CONFIG.model,
          device: CONFIG.device,
          dtype: CONFIG.dtype
        });
      });

      socket.addEventListener('close', (event) => {
        clearTimeout(connectTimer);
        bridgeEl.textContent = 'disconnected';
        log('Bridge disconnected (' + event.code + ' ' + (event.reason || 'no reason') + '); reconnecting');
        setTimeout(connect, 1000);
      });

      socket.addEventListener('error', () => {
        clearTimeout(connectTimer);
        bridgeEl.textContent = 'error';
        log('WebSocket error');
      });

      socket.addEventListener('message', (event) => {
        const payload = safeJson(event.data);
        if (!payload || payload.type !== 'generate') return;
        queue = queue
          .then(() => generate(payload.id, payload.request || {}))
          .catch((error) => {
            send({
              type: 'error',
              id: payload.id,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      });
    }

    function safeJson(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }

    function contentToText(content) {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          if (part.type === 'text') return String(part.text || '');
          return '';
        })
        .filter(Boolean)
        .join('\\n');
    }

    function normalizeMessages(messages) {
      if (!Array.isArray(messages)) return [];
      return messages
        .map((message) => ({
          role: typeof message.role === 'string' ? message.role : 'user',
          content: contentToText(message.content)
        }))
        .filter((message) => message.content);
    }

    async function loadGenerator() {
      if (generatorPromise) return generatorPromise;
      const runtime = await loadTransformersRuntime();
      generatorPromise = runtime.pipeline('text-generation', CONFIG.model, {
        dtype: CONFIG.dtype,
        device: CONFIG.device,
        progress_callback: (info) => {
          if (!info || info.status !== 'progress_total') return;
          const loaded = Number(info.loaded || 0);
          const total = Number(info.total || 0);
          const progress = Number(info.progress || 0);
          const message = total > 0
            ? (loaded / 1e9).toFixed(2) + ' GB of ' + (total / 1e9).toFixed(2) + ' GB (' + Math.round(progress) + '%)'
            : 'Downloading model';
          setRuntime('loading', message, progress);
        }
      })
        .then((generator) => {
          setRuntime('ready', 'ready', 100);
          log('Model loaded');
          return generator;
        })
        .catch((error) => {
          generatorPromise = null;
          setRuntime('error', error instanceof Error ? error.message : String(error));
          throw error;
        });
      return generatorPromise;
    }

    async function generate(id, request) {
      if (busy) throw new Error('Browser model is already generating.');
      busy = true;

      const started = performance.now();
      let output = '';
      let tokens = 0;
      let firstTokenAt = 0;
      let runtime = null;

      try {
        runtime = await loadTransformersRuntime();
        runtime.stoppingCriteria.reset();
        setRuntime('generating', 'generating');

        const generator = await loadGenerator();
        const streamer = new runtime.TextStreamer(generator.tokenizer, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (delta) => {
            if (!delta) return;
            output += delta;
            send({ type: 'delta', id, delta });
          },
          token_callback_function: () => {
            tokens += 1;
            if (tokens === 1) firstTokenAt = performance.now();
          }
        });

        const maxNewTokens = Number.isFinite(Number(request.max_tokens))
          ? Number(request.max_tokens)
          : CONFIG.maxNewTokens;
        const temperature = Number(request.temperature);
        const topP = Number(request.top_p);
        const generationOptions = {
          max_new_tokens: Math.max(1, Math.floor(maxNewTokens)),
          streamer,
          stopping_criteria: runtime.stoppingCriteria,
          do_sample: Number.isFinite(temperature) && temperature > 0,
        };
        if (Number.isFinite(temperature) && temperature > 0) {
          generationOptions.temperature = temperature;
        }
        if (Number.isFinite(topP) && topP > 0 && topP <= 1) {
          generationOptions.top_p = topP;
        }

        const result = await generator(normalizeMessages(request.messages), generationOptions);
        if (!output && Array.isArray(result) && result[0]?.generated_text) {
          const generated = result[0].generated_text;
          if (Array.isArray(generated)) {
            output = contentToText(generated[generated.length - 1]?.content || '');
          } else {
            output = String(generated || '');
          }
        }

        const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
        const tps = tokens > 1 && firstTokenAt
          ? Math.round(((tokens - 1) / ((performance.now() - firstTokenAt) / 1000)) * 10) / 10
          : Math.round((tokens / elapsed) * 10) / 10;
        log('Completed request ' + id + ' (' + tps + ' tok/s)');
        send({ type: 'complete', id, content: output.trim(), tokens, tps });
      } catch (error) {
        log('Generation failed: ' + (error instanceof Error ? error.message : String(error)));
        send({
          type: 'error',
          id,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        busy = false;
        if (runtime) setRuntime('ready', 'ready', 100);
      }
    }

    log('Bridge page initialized for ' + CONFIG.model + ' on ' + CONFIG.device + ' / ' + CONFIG.dtype);
    connect();
    if (!navigator.gpu && CONFIG.device === 'webgpu') {
      setRuntime('error', 'WebGPU is not available in this browser', 0);
      log('WebGPU is not available. Use current Chrome or Edge, or start with --device wasm.');
    } else {
      setRuntime('idle', 'idle', 0);
      void loadTransformersRuntime().catch(() => {});
    }
  </script>
</body>
</html>`;
}
