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
  ]);
  if (transformersAssets.has(assetPath)) {
    return getTransformersDistPath(assetPath);
  }

  const onnxRuntimeAssets = new Set([
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
  ]);
  if (onnxRuntimeAssets.has(assetPath)) {
    return path.join(getPackageRoot('onnxruntime-web'), 'dist', assetPath);
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
  let normalizedAssetPath: string;
  try {
    normalizedAssetPath = decodeURIComponent(vendorPath).replace(
      /^\/vendor\/+/u,
      '',
    );
  } catch {
    textResponse(res, 404, 'Not found');
    return;
  }
  if (normalizedAssetPath === 'transformers.worker.js') {
    const source = readFileSync(
      getTransformersDistPath('transformers.web.js'),
      'utf-8',
    )
      .replace(
        'from "onnxruntime-common";',
        'from "/vendor/onnxruntime-common/index.js";',
      )
      .replace(
        'from "onnxruntime-web/webgpu";',
        'from "/vendor/onnxruntime-web.js";',
      )
      .replace('from "onnxruntime-web";', 'from "/vendor/onnxruntime-web.js";');
    textResponse(res, 200, source, 'text/javascript; charset=utf-8');
    return;
  }

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

export function buildBrowserBridgeWorkerScript(): string {
  return `
let CONFIG = null;
let transformersPromise = null;
let transformersRuntime = null;
let generatorPromise = null;
let busy = false;

function post(payload) {
  self.postMessage(payload);
}

function log(message, data) {
  post({ type: 'log', message, data });
}

function setRuntime(state, message, progress) {
  post({ type: 'status', state, message: message || state, progress });
}

function stringifyUnknown(value) {
  try {
    return JSON.stringify(value, (_key, next) => {
      if (typeof next === 'bigint') return String(next);
      if (next instanceof Error) return errorToData(next);
      return next;
    });
  } catch {
    return String(value);
  }
}

function errorToData(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause instanceof Error ? errorToData(error.cause) : stringifyUnknown(error.cause),
    };
  }
  return {
    name: typeof error,
    message: String(error),
    raw: stringifyUnknown(error),
  };
}

function formatError(error) {
  const data = errorToData(error);
  if (/^\\d+$/.test(data.message)) {
    return 'Browser runtime failed with code ' + data.message + '. Try a smaller max token limit, q4 quantization, or the wasm device fallback.';
  }
  return data.message || String(error);
}

function workerEnvironment() {
  return {
    href: self.location.href,
    userAgent: self.navigator.userAgent,
    hasWebGpu: 'gpu' in self.navigator,
    crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: self.navigator.hardwareConcurrency,
    deviceMemory: 'deviceMemory' in self.navigator ? self.navigator.deviceMemory : undefined,
  };
}

async function loadTransformersRuntime() {
  if (transformersRuntime) return transformersRuntime;
  if (!transformersPromise) {
    setRuntime('loading', 'loading Transformers.js runtime', 0);
    log('Loading Transformers.js runtime', workerEnvironment());
    transformersPromise = import('/vendor/transformers.worker.js')
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
        log('Transformers.js runtime loaded', workerEnvironment());
        setRuntime('idle', 'idle', undefined);
        return transformersRuntime;
      })
      .catch((error) => {
        transformersPromise = null;
        const message = 'runtime import failed: ' + formatError(error);
        setRuntime('error', message, undefined);
        log('Transformers.js runtime failed', errorToData(error));
        throw error;
      });
  }
  return transformersPromise;
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
    .map((message) => {
      const role = typeof message.role === 'string' ? message.role : 'user';
      const normalizedRole =
        role === 'system' || role === 'assistant'
          ? role
          : 'user';
      return {
        role: normalizedRole,
        content: contentToText(message.content)
      };
    })
    .filter((message) => message.content);
}

function renderPrompt(generator, messages) {
  const normalized = normalizeMessages(messages);
  const tokenizer = generator && generator.tokenizer;
  if (tokenizer && typeof tokenizer.apply_chat_template === 'function') {
    try {
      return tokenizer.apply_chat_template(normalized, {
        tokenize: false,
        add_generation_prompt: true,
      });
    } catch (error) {
      log('Chat template failed; falling back to plain prompt', errorToData(error));
    }
  }
  return normalized
    .map((message) => message.role.toUpperCase() + ':\\n' + message.content)
    .join('\\n\\n') + '\\n\\nASSISTANT:\\n';
}

function extractGeneratedText(result) {
  if (!Array.isArray(result) || !result[0] || typeof result[0] !== 'object') {
    return '';
  }
  const generated = result[0].generated_text;
  if (typeof generated === 'string') return generated;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    return last && typeof last === 'object' ? contentToText(last.content) : '';
  }
  return '';
}

async function loadGenerator() {
  if (generatorPromise) return generatorPromise;
  if (!CONFIG) throw new Error('Bridge worker is not initialized.');
  const runtime = await loadTransformersRuntime();
  setRuntime('loading', 'loading model', 0);
  log('Loading model', {
    model: CONFIG.model,
    device: CONFIG.device,
    dtype: CONFIG.dtype,
    environment: workerEnvironment(),
  });
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
      log('Model loaded', {
        model: CONFIG.model,
        device: CONFIG.device,
        dtype: CONFIG.dtype,
        hasTokenizer: Boolean(generator.tokenizer),
        hasChatTemplate: Boolean(generator.tokenizer && generator.tokenizer.chat_template),
      });
      return generator;
    })
    .catch((error) => {
      generatorPromise = null;
      setRuntime('error', formatError(error), undefined);
      log('Model load failed', errorToData(error));
      throw error;
    });
  return generatorPromise;
}

async function generate(id, request) {
  if (!CONFIG) throw new Error('Bridge worker is not initialized.');
  if (busy) throw new Error('Browser model is already generating.');
  busy = true;

  const started = performance.now();
  let output = '';
  let tokens = 0;
  let firstTokenAt = 0;
  let phase = 'runtime';

  try {
    const runtime = await loadTransformersRuntime();
    runtime.stoppingCriteria.reset();

    phase = 'model';
    const generator = await loadGenerator();
    phase = 'prompt';
    const promptText = renderPrompt(generator, request.messages);
    log('Prompt rendered', {
      messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
      promptChars: promptText.length,
      maxNewTokens: request.max_tokens || CONFIG.maxNewTokens,
      environment: workerEnvironment(),
    });
    setRuntime('generating', 'generating', 100);

    const streamer = new runtime.TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (delta) => {
        if (!delta) return;
        output += delta;
        post({ type: 'delta', id, delta });
      },
      token_callback_function: () => {
        tokens += 1;
        if (tokens === 1) firstTokenAt = performance.now();
      }
    });

    const maxNewTokens = Number.isFinite(Number(request.max_tokens))
      ? Number(request.max_tokens)
      : CONFIG.maxNewTokens;
    const temperature = Number.isFinite(Number(request.temperature))
      ? Number(request.temperature)
      : 0.1;
    const topP = Number(request.top_p);
    const topK = Number.isFinite(Number(request.top_k))
      ? Number(request.top_k)
      : 50;
    const repetitionPenalty = Number.isFinite(Number(request.repetition_penalty))
      ? Number(request.repetition_penalty)
      : 1.05;
    const generationOptions = {
      add_special_tokens: false,
      return_full_text: false,
      max_new_tokens: Math.max(1, Math.floor(maxNewTokens)),
      temperature,
      top_k: topK,
      repetition_penalty: repetitionPenalty,
      streamer,
      stopping_criteria: runtime.stoppingCriteria,
      do_sample: temperature > 0,
    };
    if (Number.isFinite(topP) && topP > 0 && topP <= 1) {
      generationOptions.top_p = topP;
    }

    phase = 'generation';
    const result = await generator(promptText, generationOptions);
    const fallbackText = extractGeneratedText(result);
    const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
    const tps = tokens > 1 && firstTokenAt
      ? Math.round(((tokens - 1) / ((performance.now() - firstTokenAt) / 1000)) * 10) / 10
      : Math.round((tokens / elapsed) * 10) / 10;
    log('Completed request ' + id + ' (' + tps + ' tok/s)', {
      streamedChars: output.length,
      fallbackChars: fallbackText.length,
      elapsedMs: Math.round(performance.now() - started),
    });
    post({
      type: 'complete',
      id,
      content: (output || fallbackText).trim(),
      tokens,
      tps
    });
  } catch (error) {
    const details = {
      error: errorToData(error),
      environment: workerEnvironment(),
      request: {
        phase,
        messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
        maxTokens: request.max_tokens || CONFIG.maxNewTokens,
      },
    };
    log('Generation failed', details);
    setRuntime('error', formatError(error), undefined);
    post({
      type: 'error',
      id,
      error: formatError(error),
      details
    });
  } finally {
    busy = false;
    if (transformersRuntime) setRuntime('ready', 'ready', 100);
  }
}

self.addEventListener('message', (event) => {
  const payload = event.data || {};
  if (payload.type === 'init') {
    CONFIG = payload.config;
    log('Bridge worker initialized', { config: CONFIG, environment: workerEnvironment() });
    void loadTransformersRuntime().catch(() => {});
    return;
  }
  if (payload.type === 'generate') {
    void generate(payload.id, payload.request || {});
  }
});

self.addEventListener('error', (event) => {
  post({
    type: 'error',
    id: null,
    error: event.error ? formatError(event.error) : event.message,
    details: {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error ? errorToData(event.error) : null,
      environment: workerEnvironment(),
    }
  });
});

self.addEventListener('unhandledrejection', (event) => {
  post({
    type: 'error',
    id: null,
    error: formatError(event.reason),
    details: {
      error: errorToData(event.reason),
      environment: workerEnvironment(),
    }
  });
});
`;
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
      appearance: none;
      -webkit-appearance: none;
      border: 0;
      border-radius: 999px;
      overflow: hidden;
      background: #2a2e35;
    }
    progress::-webkit-progress-bar {
      background: #2a2e35;
      border-radius: 999px;
    }
    progress::-webkit-progress-value {
      background: #e4e4e7;
      border-radius: 999px;
      transition: width 160ms ease;
    }
    progress::-moz-progress-bar {
      background: #e4e4e7;
      border-radius: 999px;
      transition: width 160ms ease;
    }
    progress.is-generating::-webkit-progress-value {
      background: linear-gradient(90deg, #e4e4e7 0%, #e4e4e7 30%, #5eead4 48%, #22d3ee 52%, #e4e4e7 70%, #e4e4e7 100%);
      background-size: 220% 100%;
      animation: bridge-progress-scan 1.1s linear infinite;
    }
    progress.is-generating::-moz-progress-bar {
      background: linear-gradient(90deg, #e4e4e7 0%, #e4e4e7 30%, #5eead4 48%, #22d3ee 52%, #e4e4e7 70%, #e4e4e7 100%);
      background-size: 220% 100%;
      animation: bridge-progress-scan 1.1s linear infinite;
    }
    @keyframes bridge-progress-scan {
      from {
        background-position: 220% 0;
      }
      to {
        background-position: 0 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      progress.is-generating::-webkit-progress-value,
      progress.is-generating::-moz-progress-bar {
        animation: none;
        background: #5eead4;
      }
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
    let busy = false;
    let queue = Promise.resolve();
    const workerRequests = new Map();
    const modelWorker = new Worker('/bridge/worker.js', { type: 'module' });

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
      progressEl.classList.toggle('is-generating', state === 'generating');
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

    function describe(value) {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    modelWorker.addEventListener('message', (event) => {
      const payload = event.data || {};
      if (payload.type === 'log') {
        log(payload.message + (payload.data === undefined ? '' : ': ' + describe(payload.data)));
        return;
      }
      if (payload.type === 'status') {
        setRuntime(payload.state, payload.message, payload.progress);
        return;
      }
      const id = typeof payload.id === 'string' ? payload.id : '';
      if (payload.type === 'delta') {
        send({ type: 'delta', id, delta: payload.delta || '' });
        return;
      }
      if (payload.type === 'complete') {
        send({
          type: 'complete',
          id,
          content: payload.content || '',
          tokens: typeof payload.tokens === 'number' ? payload.tokens : 0,
          tps: payload.tps
        });
        const pending = workerRequests.get(id);
        workerRequests.delete(id);
        busy = false;
        pending?.resolve();
        return;
      }
      if (payload.type === 'error') {
        log('Generation failed: ' + (payload.error || 'Browser generation failed.'));
        if (payload.details) log('Generation details: ' + describe(payload.details));
        if (id) {
          send({
            type: 'error',
            id,
            error: payload.error || 'Browser generation failed.',
            details: payload.details
          });
          const pending = workerRequests.get(id);
          workerRequests.delete(id);
          pending?.resolve();
        }
        busy = false;
      }
    });

    modelWorker.addEventListener('error', (event) => {
      log('Bridge worker error: ' + (event.message || 'unknown error'));
      for (const [id, pending] of workerRequests) {
        send({ type: 'error', id, error: event.message || 'Bridge worker error.' });
        pending.resolve();
      }
      workerRequests.clear();
      busy = false;
    });

    modelWorker.postMessage({ type: 'init', config: CONFIG });

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

    async function generate(id, request) {
      if (busy) throw new Error('Browser model is already generating.');
      busy = true;
      setRuntime('loading', 'queued', progressEl.value);
      return new Promise((resolve) => {
        workerRequests.set(id, { resolve });
        modelWorker.postMessage({ type: 'generate', id, request });
      });
    }

    log('Bridge page initialized for ' + CONFIG.model + ' on ' + CONFIG.device + ' / ' + CONFIG.dtype);
    connect();
    if (!navigator.gpu && CONFIG.device === 'webgpu') {
      setRuntime('error', 'WebGPU is not available in this browser', 0);
      log('WebGPU is not available. Use current Chrome or Edge, or start with --device wasm.');
    } else {
      setRuntime('idle', 'idle', 0);
    }
  </script>
</body>
</html>`;
}
