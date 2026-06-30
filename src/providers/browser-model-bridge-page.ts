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
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.jspi.mjs',
    'ort-wasm-simd-threaded.jspi.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
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
let loadedGenerator = null;
let busy = false;
let lastLoadProgressAt = 0;
let lastLoadProgressPercent = -1;
let fileLoadBytes = {};
let lastModelLoadProgress = null;
let consoleForwardingInstalled = false;
let transformersVersion = null;
const CONSOLE_FORWARD_ARG_LIMIT = 4;
const CONSOLE_FORWARD_VALUE_CHARS = 2000;

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

function truncateForwardedConsoleValue(value) {
  const text = stringifyUnknown(value);
  if (text.length <= CONSOLE_FORWARD_VALUE_CHARS) return text;
  return text.slice(0, CONSOLE_FORWARD_VALUE_CHARS) +
    '... [truncated ' + (text.length - CONSOLE_FORWARD_VALUE_CHARS) + ' chars]';
}

function sanitizeForwardedConsoleArgs(args) {
  const values = args
    .slice(0, CONSOLE_FORWARD_ARG_LIMIT)
    .map((arg) => truncateForwardedConsoleValue(arg));
  if (args.length > CONSOLE_FORWARD_ARG_LIMIT) {
    values.push('[truncated ' + (args.length - CONSOLE_FORWARD_ARG_LIMIT) + ' args]');
  }
  return values;
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
    transformersVersion,
  };
}

function installConsoleForwarding() {
  if (consoleForwardingInstalled) return;
  consoleForwardingInstalled = true;
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args) => {
    log('Browser console warning', sanitizeForwardedConsoleArgs(args));
    originalWarn(...args);
  };
  console.error = (...args) => {
    log('Browser console error', sanitizeForwardedConsoleArgs(args));
    originalError(...args);
  };
}

async function loadTransformersRuntime() {
  if (transformersRuntime) return transformersRuntime;
  if (!transformersPromise) {
    setRuntime('loading', 'loading Transformers.js runtime', 0);
    log('Loading Transformers.js runtime', workerEnvironment());
    installConsoleForwarding();
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
        transformersVersion = runtime.env.version || null;
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

function toToolCallArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return {};
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      const role = typeof message.role === 'string' ? message.role : 'user';
      const normalizedRole =
        role === 'system' || role === 'assistant' || role === 'tool'
          ? role
          : 'user';
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
            .map((toolCall) => {
              const functionRecord =
                toolCall && typeof toolCall.function === 'object'
                  ? toolCall.function
                  : {};
              return {
                id: typeof toolCall.id === 'string' ? toolCall.id : '',
                type: 'function',
                function: {
                  name:
                    typeof functionRecord.name === 'string'
                      ? functionRecord.name
                      : '',
                  // The chat template iterates arguments with .items(), so it
                  // must be an object. OpenAI sends a JSON string; parse it back
                  // so multi-turn tool histories render via the native template
                  // instead of falling back to a plain prompt.
                  arguments: toToolCallArguments(functionRecord.arguments),
                },
              };
            })
            .filter((toolCall) => toolCall.function.name)
        : [];
      return {
        role: normalizedRole,
        content: contentToText(message.content),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(normalizedRole === 'tool' && typeof message.tool_call_id === 'string'
          ? { tool_call_id: message.tool_call_id }
          : {}),
      };
    })
    .filter((message) => message.content || message.tool_calls);
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      const functionRecord =
        tool && typeof tool.function === 'object' ? tool.function : tool;
      const name =
        functionRecord && typeof functionRecord.name === 'string'
          ? functionRecord.name
          : '';
      if (!name) return null;
      return {
        name,
        description:
          typeof functionRecord.description === 'string'
            ? functionRecord.description
            : '',
        parameters:
          functionRecord && typeof functionRecord.parameters === 'object'
            ? functionRecord.parameters
            : { type: 'object', properties: {}, required: [] },
      };
    })
    .filter(Boolean);
}

function isLiquidModel(model) {
  const normalized = String(model || '').trim().toLowerCase();
  return normalized.includes('liquidai') ||
    normalized.includes('/liquid/') ||
    normalized.includes('lfm');
}

// LFM/Liquid chat templates were trained on the flattened tool shape
// ({name, description, parameters} rendered as "List of tools: [...]"), but the
// standard HF templates (Gemma, Qwen, ...) read the nested OpenAI shape and
// access tool.function.name/.description/.parameters. Passing the flattened
// shape to those templates renders empty tool declarations, so wrap tools in
// the nested shape for every non-Liquid model.
function toolsForChatTemplate(normalizedTools) {
  if (isLiquidModel(CONFIG && CONFIG.model)) return normalizedTools;
  return normalizedTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function stripUnsupportedChatTemplateBlocks(template) {
  return template
    .replace(/\\{%-?\\s*generation\\s*-?%\\}/g, '')
    .replace(/\\{%-?\\s*endgeneration\\s*-?%\\}/g, '');
}

function applyChatTemplate(tokenizer, messages, chatTemplate, tools) {
  const normalizedTools = toolsForChatTemplate(normalizeTools(tools));
  return tokenizer.apply_chat_template(messages, {
    tokenize: false,
    add_generation_prompt: true,
    ...(normalizedTools.length > 0 ? { tools: normalizedTools } : {}),
    ...(chatTemplate ? { chat_template: chatTemplate } : {}),
  });
}

function renderPlainPrompt(messages, tools) {
  const normalizedTools = normalizeTools(tools);
  const toolInstruction =
    normalizedTools.length > 0
      ? (isLiquidModel(CONFIG && CONFIG.model)
          ? 'Liquid tool call format: <|tool_call_start|>[tools.<tool_name>(key=value)]<|tool_call_end|>.\\n'
          : 'Tool call format: call:<tool_name>{key:value}.\\n') +
        'List of tools: ' +
        JSON.stringify(normalizedTools) +
        '\\n\\n'
      : '';
  return toolInstruction + messages
    .map((message) => {
      if (message.role === 'tool') {
        return (
          'TOOL RESULT' +
          (message.tool_call_id ? ' ' + message.tool_call_id : '') +
          ':\\n' +
          message.content
        );
      }
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        return (
          'ASSISTANT TOOL CALLS:\\n' +
          JSON.stringify(message.tool_calls) +
          (message.content ? '\\n\\nASSISTANT:\\n' + message.content : '')
        );
      }
      return message.role.toUpperCase() + ':\\n' + message.content;
    })
    .join('\\n\\n') + '\\n\\nASSISTANT:\\n';
}

function renderPrompt(generator, messages, tools) {
  const normalized = normalizeMessages(messages);
  const tokenizer = generator && generator.tokenizer;
  if (tokenizer && typeof tokenizer.apply_chat_template === 'function') {
    const template = typeof tokenizer.chat_template === 'string'
      ? tokenizer.chat_template
      : '';
    const strippedTemplate = template
      ? stripUnsupportedChatTemplateBlocks(template)
      : '';
    const renderTemplate =
      strippedTemplate && strippedTemplate !== template
        ? strippedTemplate
        : undefined;
    try {
      const rendered = applyChatTemplate(tokenizer, normalized, renderTemplate, tools);
      if (renderTemplate) {
        log('Chat template rendered with unsupported generation blocks removed');
      }
      return rendered;
    } catch (error) {
      const canRetry =
        strippedTemplate &&
        strippedTemplate !== template &&
        !renderTemplate &&
        /Unknown statement type:\\s*(generation|endgeneration)/.test(
          String(error && error.message ? error.message : error),
        );
      if (canRetry) {
        try {
          const rendered = applyChatTemplate(
            tokenizer,
            normalized,
            strippedTemplate,
            tools,
          );
          log('Chat template rendered after removing unsupported generation blocks', {
            originalError: errorToData(error),
          });
          return rendered;
        } catch (retryError) {
          log('Chat template retry failed; falling back to plain prompt', {
            originalError: errorToData(error),
            retryError: errorToData(retryError),
          });
        }
      } else {
        log('Chat template failed; falling back to plain prompt', errorToData(error));
      }
    }
  }
  return renderPlainPrompt(normalized, tools);
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

function finiteNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function shouldDebugModelRequest(request) {
  return request && request.hybridclaw_debug_model_responses === true;
}

function debugGenerationOptions(options) {
  return {
    add_special_tokens: options.add_special_tokens,
    return_full_text: options.return_full_text,
    max_new_tokens: options.max_new_tokens,
    temperature: options.temperature,
    top_k: options.top_k,
    top_p: options.top_p,
    repetition_penalty: options.repetition_penalty,
    do_sample: options.do_sample,
  };
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1000 && unitIndex < units.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : 2;
  return scaled.toFixed(decimals) + ' ' + units[unitIndex];
}

function normalizeProgressInfo(info) {
  const status = String(info && info.status ? info.status : 'loading');
  const name = String(info && info.name ? info.name : '');
  const file = String(info && info.file ? info.file : '');
  const loaded = finiteNumber(info && info.loaded);
  const total = finiteNumber(info && info.total);
  let progress = finiteNumber(info && info.progress);
  if (progress === null && loaded !== null && total !== null && total > 0) {
    progress = loaded / total * 100;
  }
  const roundedProgress =
    progress === null ? -1 : Math.max(0, Math.min(100, Math.round(progress)));
  const label = file || name || CONFIG.model;
  let message = status;
  if (label) message += ' ' + label;
  if (loaded !== null && total !== null && total > 0) {
    message += ': ' + formatBytes(loaded) + ' of ' + formatBytes(total);
    if (roundedProgress >= 0) message += ' (' + roundedProgress + '%)';
  } else if (roundedProgress >= 0) {
    message += ' (' + roundedProgress + '%)';
  }
  return {
    status,
    name,
    file,
    loaded,
    total,
    progress,
    roundedProgress,
    message,
  };
}

// Track each downloaded file's bytes so we can report one smooth aggregate.
// Large models (e.g. LFM2.5-8B) ship as several multi-GB shards; transformers.js
// stops emitting 'progress_total' between shards and reports the rest as per-file
// 'progress' events, so relying on a single status freezes the bar mid-download.
function trackFileBytes(progress) {
  if (!progress.file) return;
  const entry = fileLoadBytes[progress.file] || { loaded: 0, total: 0 };
  if (progress.total !== null && progress.total > entry.total) {
    entry.total = progress.total;
  }
  if (progress.status === 'done' && entry.total > 0) {
    entry.loaded = entry.total;
  } else if (progress.loaded !== null && progress.loaded > entry.loaded) {
    entry.loaded = progress.loaded;
  }
  fileLoadBytes[progress.file] = entry;
}

function aggregateLoadProgress() {
  let loaded = 0;
  let total = 0;
  for (const file in fileLoadBytes) {
    const entry = fileLoadBytes[file];
    if (entry.total > 0) {
      total += entry.total;
      loaded += Math.min(entry.loaded, entry.total);
    }
  }
  if (total <= 0) return null;
  return {
    loaded,
    total,
    percent: Math.max(0, Math.min(100, (loaded / total) * 100)),
  };
}

function reportLoadProgress(info) {
  if (!info) return;
  const progress = normalizeProgressInfo(info);
  trackFileBytes(progress);
  lastModelLoadProgress = {
    status: progress.status,
    name: progress.name || undefined,
    file: progress.file || undefined,
    loaded: progress.loaded ?? undefined,
    total: progress.total ?? undefined,
    progress: progress.progress ?? undefined,
  };

  const aggregate = aggregateLoadProgress();
  const percent = aggregate ? Math.round(aggregate.percent) : -1;
  const milestone =
    progress.status !== 'progress' && progress.status !== 'progress_total';
  const now = performance.now();
  const moved =
    percent >= 0 &&
    percent !== lastLoadProgressPercent &&
    now - lastLoadProgressAt >= 300;
  if (!milestone && !moved) return;
  lastLoadProgressAt = now;
  if (percent >= 0) lastLoadProgressPercent = percent;

  const barValue = aggregate
    ? aggregate.percent
    : progress.progress === null
      ? undefined
      : progress.progress;
  const message = aggregate
    ? 'downloading ' +
      formatBytes(aggregate.loaded) +
      ' of ' +
      formatBytes(aggregate.total) +
      ' (' +
      percent +
      '%)'
    : progress.message;
  setRuntime('loading', message, barValue);
  log('Model load progress', {
    ...lastModelLoadProgress,
    aggregateLoaded: aggregate ? aggregate.loaded : undefined,
    aggregateTotal: aggregate ? aggregate.total : undefined,
    aggregatePercent: percent >= 0 ? percent : undefined,
  });
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
  lastLoadProgressAt = 0;
  lastLoadProgressPercent = -1;
  fileLoadBytes = {};
  lastModelLoadProgress = null;
  generatorPromise = runtime.pipeline('text-generation', CONFIG.model, {
    dtype: CONFIG.dtype,
    device: CONFIG.device,
    progress_callback: reportLoadProgress
  })
    .then((generator) => {
      loadedGenerator = generator;
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
      log('Model load failed', {
        error: errorToData(error),
        lastProgress: lastModelLoadProgress,
        environment: workerEnvironment(),
      });
      throw error;
    });
  return generatorPromise;
}

function resolveVocabSize(generator) {
  const candidates = [];
  try {
    const config = generator && generator.model && generator.model.config;
    if (config) {
      candidates.push(config.vocab_size);
      if (config.text_config) candidates.push(config.text_config.vocab_size);
      if (config.decoder) candidates.push(config.decoder.vocab_size);
    }
    const tokenizer = generator && generator.tokenizer;
    if (tokenizer) {
      if (typeof tokenizer.getVocabSize === 'function') {
        try {
          candidates.push(tokenizer.getVocabSize());
        } catch {}
      }
      const model = tokenizer.model;
      if (model && model.vocab) {
        candidates.push(
          Array.isArray(model.vocab)
            ? model.vocab.length
            : Object.keys(model.vocab).length,
        );
      }
    }
  } catch {}
  const valid = candidates
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  // The logits projection (which overflows) is the largest vocabulary, so take
  // the max candidate to keep the safe-length estimate conservative.
  const vocabSize = valid.length > 0 ? Math.max(...valid) : 0;
  log('Resolved vocab size', { candidates, vocabSize });
  return vocabSize;
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
  let failed = false;

  try {
    const runtime = await loadTransformersRuntime();
    runtime.stoppingCriteria.reset();

    phase = 'model';
    const generator = await loadGenerator();
    phase = 'prompt';
    const forcedPrefix =
      typeof request.force_assistant_prefix === 'string'
        ? request.force_assistant_prefix
        : '';
    const promptText =
      renderPrompt(generator, request.messages, request.tools) + forcedPrefix;
    log('Prompt rendered', {
      messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
      toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
      promptChars: promptText.length,
      maxNewTokens: request.max_tokens || CONFIG.maxNewTokens,
      environment: workerEnvironment(),
    });

    // Reject prompts that would overflow the runtime BEFORE running the model.
    // onnxruntime sizes the prefill logits tensor ([seq, vocab] float32) with an
    // int32 byte count, so seq * vocab * 4 must stay under 2^31. Large
    // vocabularies (e.g. Gemma's ~262K) cap the usable prompt far below the
    // model's context window, and crossing it loses the WebGPU device — which a
    // page reload can't recover from in time. Failing here keeps the session
    // healthy for later (shorter) requests. Measured on gemma-4-E2B (vocab
    // 262144): 1740 prompt tokens succeed but 2001 fail, so the 0.85 factor caps
    // the limit (~1740) at the highest confirmed-good length, independent of
    // max_new_tokens (decode logits are [1, vocab], so only the prompt matters).
    const vocabSize = resolveVocabSize(generator);
    if (Number.isFinite(vocabSize) && vocabSize > 0) {
      let promptTokens = 0;
      try {
        const encoded = generator.tokenizer.encode(promptText);
        promptTokens = Array.isArray(encoded) ? encoded.length : 0;
      } catch (error) {
        log('Prompt token count failed', errorToData(error));
      }
      const safeMaxTokens = Math.floor(((2 ** 31 - 1) / (vocabSize * 4)) * 0.85);
      log('Prompt length check', { promptTokens, vocabSize, safeMaxTokens });
      if (promptTokens > safeMaxTokens) {
        throw new Error(
          'Prompt is too long for ' + CONFIG.model + ': ' + promptTokens +
            " tokens exceeds this model's safe in-browser limit of ~" +
            safeMaxTokens + ' tokens (its ' + vocabSize +
            '-token vocabulary overflows the runtime at longer sequences). ' +
            'Reduce the prompt, or the number/size of tools.',
        );
      }
    }

    setRuntime('generating', 'generating', 100);

    // When the assistant turn is force-prefilled (e.g. to require a tool call),
    // the prefix lives in the prompt and is not streamed by the tokenizer, so
    // emit it as the first delta to keep streamed and final content aligned.
    if (forcedPrefix) post({ type: 'delta', id, delta: forcedPrefix });

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

    if (shouldDebugModelRequest(request)) {
      log('Debug model request', {
        id,
        model: CONFIG.model,
        device: CONFIG.device,
        dtype: CONFIG.dtype,
        promptText,
        generationOptions: debugGenerationOptions(generationOptions),
        request: {
          messages: request.messages,
          tools: request.tools,
          tool_choice: request.tool_choice,
          max_tokens: request.max_tokens,
          temperature: request.temperature,
          top_p: request.top_p,
          top_k: request.top_k,
          repetition_penalty: request.repetition_penalty,
        },
        environment: workerEnvironment(),
      });
    }

    phase = 'generation';
    const result = await generator(promptText, generationOptions);
    const fallbackText = extractGeneratedText(result);
    const content = (forcedPrefix + (output || fallbackText)).trim();
    const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
    const tps = tokens > 1 && firstTokenAt
      ? Math.round(((tokens - 1) / ((performance.now() - firstTokenAt) / 1000)) * 10) / 10
      : Math.round((tokens / elapsed) * 10) / 10;
    if (shouldDebugModelRequest(request)) {
      log('Debug model response', {
        id,
        model: CONFIG.model,
        streamedText: output,
        fallbackText,
        content,
        tokens,
        tps,
        rawResult: result,
        elapsedMs: Math.round(performance.now() - started),
        environment: workerEnvironment(),
      });
    }
    log('Completed request ' + id + ' (' + tps + ' tok/s)', {
      streamedChars: output.length,
      fallbackChars: fallbackText.length,
      elapsedMs: Math.round(performance.now() - started),
    });
    post({
      type: 'complete',
      id,
      content,
      tokens,
      tps
    });
  } catch (error) {
    failed = true;
    const rawMessage = formatError(error);
    // A runtime fault during execution (e.g. onnxruntime "Integer overflow" on
    // an over-long prompt) leaves the ONNX session unusable, so discard the
    // cached generator and let the next request rebuild a fresh one instead of
    // every later request failing on the poisoned session.
    if (phase === 'generation' || phase === 'model') {
      try {
        if (loadedGenerator && typeof loadedGenerator.dispose === 'function') {
          void loadedGenerator.dispose();
        }
      } catch {}
      loadedGenerator = null;
      generatorPromise = null;
    }
    const isRuntimeOverflow = /integer overflow|OrtRun/i.test(rawMessage);
    const userMessage = isRuntimeOverflow
      ? 'The model runtime hit an integer overflow, which means the prompt is too long for this browser model. Reduce the prompt size (fewer or smaller tools, shorter messages) or use a model with a smaller vocabulary.'
      : rawMessage;
    const details = {
      error: errorToData(error),
      environment: workerEnvironment(),
      request: {
        phase,
        messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
        maxTokens: request.max_tokens || CONFIG.maxNewTokens,
      },
      modelLoad: phase === 'model' ? { lastProgress: lastModelLoadProgress } : undefined,
    };
    log('Generation failed', details);
    setRuntime('error', userMessage, undefined);
    post({
      type: 'error',
      id,
      error: userMessage,
      details
    });
  } finally {
    busy = false;
    if (!failed && generatorPromise) setRuntime('ready', 'ready', 100);
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
      height: 100vh;
      box-sizing: border-box;
      padding: 24px 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #101113;
      overflow: hidden;
    }
    main {
      width: min(760px, calc(100vw - 32px));
      max-height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    main > h1,
    section.panel {
      flex: 0 0 auto;
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
    .log-panel {
      display: flex;
      flex-direction: column;
      min-height: 0;
      padding: 0;
      flex: 0 0 auto;
    }
    .log-panel[open] {
      flex: 1 1 auto;
    }
    /* Chrome wraps <details> content in ::details-content; make it the flex
       scroll container so the log fills the panel and scrolls internally
       instead of overflowing and growing the page. */
    .log-panel::details-content {
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .log-summary {
      cursor: pointer;
      padding: 16px 18px;
      font-size: 13px;
      color: #a1a1aa;
      user-select: none;
      list-style: none;
    }
    .log-summary::-webkit-details-marker {
      display: none;
    }
    .log-summary::before {
      content: '▶';
      display: inline-block;
      margin-right: 8px;
      font-size: 10px;
      transition: transform 120ms ease;
    }
    .log-panel[open] .log-summary::before {
      transform: rotate(90deg);
    }
    .log {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #d4d4d8;
      padding: 0 18px 18px;
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
    <details class="panel log-panel">
      <summary class="log-summary">Log</summary>
      <div class="log" id="log"></div>
    </details>
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

    function log(message, data) {
      const stamp = new Date().toLocaleTimeString();
      const suffix = data === undefined ? '' : ': ' + describe(data);
      logEl.textContent += '[' + stamp + '] ' + message + suffix + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
      send({ type: 'log', message, data });
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
        log(payload.message, payload.data);
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
