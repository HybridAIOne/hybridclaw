#!/usr/bin/env node

// Compare response latency for the same model across three paths:
//
//   gateway    HybridClaw's local OpenAI-compatible gateway (full agent turn)
//              POST {GATEWAY}/v1/chat/completions  model=hybridai/<model>
//   hai        The HybridAI OpenAI-compatible API called directly
//              POST {HYBRIDAI_BASE_URL}/v1/chat/completions  model=<model>
//   vendor     The upstream model vendor called directly, resolved from the
//              model family:
//                claude-*      -> POST https://api.anthropic.com/v1/messages
//                gpt-* / o<n>  -> POST https://api.openai.com/v1/chat/completions
//
// Each arm runs with stream=false and stream=true. Request bodies and headers
// mirror what HybridClaw itself sends (container/src/providers/hybridai.ts and
// container/src/providers/anthropic.ts), so gateway-vs-hai isolates HybridClaw
// overhead and hai-vs-vendor isolates the HybridAI backend overhead.
//
// Usage:
//   node scripts/benchmark-model-latency.mjs [options]
//
//   --model <id>        Model to test (default: anthropic/claude-sonnet-5).
//                       Accepts sonnet-5 | claude-sonnet-5 |
//                       anthropic/claude-sonnet-5 | hybridai/anthropic/... |
//                       gpt-5.6-luna (HybridAI serves OpenAI models unprefixed)
//   --arms <list>       Comma list of gateway,hai,vendor (default: all).
//                       `anthropic` and `openai` are accepted as spellings of
//                       `vendor`.
//   --stream <mode>     both | true | false (default: both)
//   --runs <n>          Runs per arm+stream combination (default: 3)
//   --prompt <text>     Prompt to send (default: short fixed prompt)
//   --max-tokens <n>    Output token cap for the hai/vendor arms (default: 512)
//   --no-thinking       Do not inject the adaptive-thinking block HybridClaw
//                       adds for Claude models on the hai/vendor arms
//   --chatbot-id <id>   chatbot_id for the hai arm (default: env
//                       HYBRIDAI_CHATBOT_ID or config.hybridai.defaultChatbotId)
//   --vendor-model <id> Upstream model name for the vendor arm, when it differs
//                       from the HybridAI-side name
//   --openai-max-param <p>  auto | max_tokens | max_completion_tokens for the
//                       OpenAI vendor arm (default: auto — max_completion_tokens
//                       for gpt-5+/o-series, max_tokens otherwise)
//   --gateway-url <url> Gateway base URL (default: OPENAI_BASE_URL without /v1,
//                       else GATEWAY_BASE_URL, else http://127.0.0.1:9090)
//   --timeout <ms>      Per-request timeout (default: 180000)
//   --json <path>       Write raw per-run results as JSON
//   --verbose           Print reply snippets per run
//
// Credentials (env):
//   gateway    Mint a scoped, revocable token and pass it as WEB_API_TOKEN:
//                hybridclaw token create --label latency-bench --actions openai.api
//              (printed once on creation; revoke with `hybridclaw token revoke`).
//              GATEWAY_API_TOKEN and OPENAI_API_KEY are accepted as
//              alternatives; `hybridclaw eval node scripts/...` injects
//              OPENAI_API_KEY automatically but runs detached.
//   hai        HYBRIDAI_API_KEY (hai-...)
//   vendor     ANTHROPIC_API_KEY for claude-*, OPENAI_API_KEY for gpt-*/o<n>.
//              Under `hybridclaw eval` OPENAI_API_KEY is the injected gateway
//              token, so the OpenAI vendor arm is only available when the
//              script is run directly.
//
// Arms with missing credentials are skipped with a notice.

import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import tls from 'node:tls';

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const DEFAULT_HYBRIDAI_BASE_URL = 'https://hybridai.one';
const DEFAULT_GATEWAY_BASE_URL = 'http://127.0.0.1:9090';
const DEFAULT_PROMPT =
  'In one short sentence, say hello and name the model you are.';

// Same model gates HybridClaw uses when deciding to send a thinking block.
const HAI_THINKING_MODEL_RE =
  /^anthropic\/claude-(?:sonnet-(?:4-6|5)|opus-4-(?:6|7|8))(?:$|-)/;
const ANTHROPIC_THINKING_MODEL_RE =
  /^claude-(?:sonnet-(?:4-6|5)|opus-4-(?:6|7|8))(?:$|-)/;

function parseArgs(argv) {
  const options = {
    model: 'anthropic/claude-sonnet-5',
    arms: ['gateway', 'hai', 'vendor'],
    stream: 'both',
    runs: 3,
    prompt: DEFAULT_PROMPT,
    maxTokens: 512,
    thinking: true,
    chatbotId: '',
    vendorModel: '',
    openaiMaxParam: 'auto',
    gatewayUrl: '',
    timeoutMs: 180_000,
    jsonPath: '',
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case '--model':
        options.model = next();
        break;
      case '--arms':
        options.arms = next()
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
          // `anthropic`/`openai` are accepted spellings of the vendor arm.
          .map((value) =>
            value === 'anthropic' || value === 'openai' ? 'vendor' : value,
          );
        break;
      case '--stream':
        options.stream = next();
        break;
      case '--runs':
        options.runs = Number.parseInt(next(), 10);
        break;
      case '--prompt':
        options.prompt = next();
        break;
      case '--max-tokens':
        options.maxTokens = Number.parseInt(next(), 10);
        break;
      case '--no-thinking':
        options.thinking = false;
        break;
      case '--chatbot-id':
        options.chatbotId = next();
        break;
      case '--vendor-model':
        options.vendorModel = next();
        break;
      case '--openai-max-param':
        options.openaiMaxParam = next();
        break;
      case '--gateway-url':
        options.gatewayUrl = next();
        break;
      case '--timeout':
        options.timeoutMs = Number.parseInt(next(), 10);
        break;
      case '--json':
        options.jsonPath = next();
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg} (see --help)`);
    }
  }
  if (!Number.isFinite(options.runs) || options.runs < 1) {
    throw new Error('--runs must be a positive integer');
  }
  if (!['both', 'true', 'false'].includes(options.stream)) {
    throw new Error('--stream must be both, true, or false');
  }
  for (const arm of options.arms) {
    if (!['gateway', 'hai', 'vendor'].includes(arm)) {
      throw new Error(`Unknown arm: ${arm}`);
    }
  }
  if (
    !['auto', 'max_tokens', 'max_completion_tokens'].includes(
      options.openaiMaxParam,
    )
  ) {
    throw new Error(
      '--openai-max-param must be auto, max_tokens, or max_completion_tokens',
    );
  }
  return options;
}

function printUsage() {
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('//'));
  const header = [];
  for (const line of start === -1 ? [] : lines.slice(start)) {
    if (!line.startsWith('//')) break;
    header.push(line.slice(3));
  }
  console.log(header.join('\n'));
}

// Model name mapping: normalize any accepted spelling to the HybridAI-side
// name (anthropic/claude-sonnet-5), then derive per-arm names.
function normalizeModel(raw) {
  let model = String(raw || '').trim();
  model = model.replace(/^hybridai\//i, '');
  if (/^(sonnet|opus|haiku)-/i.test(model)) model = `claude-${model}`;
  if (/^claude-/i.test(model)) model = `anthropic/${model}`;
  return model;
}

function loadRuntimeConfig() {
  const home =
    process.env.HYBRIDCLAW_DATA_DIR || path.join(os.homedir(), '.hybridclaw');
  try {
    return JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function stripTrailingV1(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}

// Which upstream vendor serves this model directly, and under what name.
// HybridAI serves Anthropic models prefixed (`anthropic/claude-...`) and
// OpenAI models bare (`gpt-...`) — see container/shared/model-names.js.
function resolveVendor(haiModel, options) {
  const bare = haiModel.replace(/^[a-z0-9-]+\//i, '');
  const model = options.vendorModel || bare;
  if (/^claude-/i.test(bare)) {
    const root = stripTrailingV1(process.env.ANTHROPIC_BASE_URL);
    return {
      kind: 'anthropic',
      url: `${root ? `${root}/v1` : DEFAULT_ANTHROPIC_BASE_URL}/messages`,
      model,
      token: process.env.ANTHROPIC_API_KEY || '',
      missing: 'ANTHROPIC_API_KEY',
    };
  }
  if (/^(gpt|o\d|chatgpt)/i.test(bare)) {
    const root =
      stripTrailingV1(process.env.OPENAI_VENDOR_BASE_URL) ||
      DEFAULT_OPENAI_BASE_URL;
    return {
      kind: 'openai',
      url: `${root}/v1/chat/completions`,
      model,
      // OPENAI_API_KEY is only the vendor key here; under `hybridclaw eval` it
      // is the injected *gateway* token, so it is claimed by the gateway arm.
      token: process.env.HYBRIDCLAW_EVAL_MODEL
        ? ''
        : process.env.OPENAI_API_KEY || '',
      missing: process.env.HYBRIDCLAW_EVAL_MODEL
        ? 'OPENAI_API_KEY is reserved as the gateway token under `hybridclaw eval`; run the script directly to test the vendor arm'
        : 'OPENAI_API_KEY',
      // Newer OpenAI models reject `max_tokens` in favour of
      // `max_completion_tokens`; override with --openai-max-param.
      maxTokensParam:
        options.openaiMaxParam === 'auto'
          ? /^(gpt-[5-9]|o\d)/i.test(model)
            ? 'max_completion_tokens'
            : 'max_tokens'
          : options.openaiMaxParam,
    };
  }
  return {
    kind: null,
    model,
    unsupported: `no direct-vendor endpoint known for \`${bare}\` (supported: claude-* via Anthropic, gpt-*/o* via OpenAI). Use --vendor-model to name the upstream model explicitly.`,
  };
}

function resolveTargets(options) {
  const config = loadRuntimeConfig();
  const haiModel = normalizeModel(options.model);
  const vendor = resolveVendor(haiModel, options);

  const gatewayBaseUrl =
    stripTrailingV1(options.gatewayUrl) ||
    stripTrailingV1(process.env.OPENAI_BASE_URL) ||
    stripTrailingV1(process.env.GATEWAY_BASE_URL) ||
    DEFAULT_GATEWAY_BASE_URL;
  const haiBaseUrl =
    stripTrailingV1(process.env.HYBRIDAI_BASE_URL) ||
    stripTrailingV1(config?.hybridai?.baseUrl) ||
    DEFAULT_HYBRIDAI_BASE_URL;

  return {
    gateway: {
      arm: 'gateway',
      url: `${gatewayBaseUrl}/v1/chat/completions`,
      model: `hybridai/${haiModel}`,
      token:
        process.env.WEB_API_TOKEN ||
        process.env.GATEWAY_API_TOKEN ||
        // Only under `hybridclaw eval`, where this is the injected gateway
        // token rather than a real OpenAI key.
        (process.env.HYBRIDCLAW_EVAL_MODEL
          ? process.env.OPENAI_API_KEY || ''
          : ''),
      missing:
        'WEB_API_TOKEN (tip: mint one with `hybridclaw token create --label latency-bench --actions openai.api`)',
    },
    hai: {
      arm: 'hai',
      url: `${haiBaseUrl}/v1/chat/completions`,
      model: haiModel,
      token: process.env.HYBRIDAI_API_KEY || '',
      missing: 'HYBRIDAI_API_KEY',
      chatbotId:
        options.chatbotId ||
        process.env.HYBRIDAI_CHATBOT_ID ||
        String(config?.hybridai?.defaultChatbotId || ''),
    },
    vendor: {
      arm: 'vendor',
      label: vendor.kind ? `vendor(${vendor.kind})` : 'vendor',
      vendorKind: vendor.kind,
      url: vendor.url,
      model: vendor.model,
      token: vendor.token || '',
      missing: vendor.missing,
      unsupported: vendor.unsupported,
      maxTokensParam: vendor.maxTokensParam,
    },
  };
}

function buildRequest(target, options, stream) {
  const messages = [{ role: 'user', content: options.prompt }];
  if (target.vendorKind === 'anthropic') {
    const body = {
      model: target.model,
      max_tokens: options.maxTokens,
      messages,
      stream,
    };
    if (options.thinking && ANTHROPIC_THINKING_MODEL_RE.test(target.model)) {
      body.thinking = { type: 'adaptive', display: 'summarized' };
    }
    return {
      url: target.url,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': target.token,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_TOOL_STREAMING_BETA,
        ...(stream ? { Accept: 'text/event-stream' } : {}),
      },
      body,
    };
  }

  const body = { model: target.model, messages };
  if (target.arm === 'hai') {
    body.chatbot_id = target.chatbotId;
    body.enable_rag = false;
    body.max_tokens = options.maxTokens;
    if (options.thinking && HAI_THINKING_MODEL_RE.test(target.model)) {
      body.thinking = { type: 'adaptive', display: 'summarized' };
    }
  }
  if (target.vendorKind === 'openai') {
    body[target.maxTokensParam || 'max_tokens'] = options.maxTokens;
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return {
    url: target.url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${target.token}`,
      ...(stream
        ? {
            Accept: 'text/event-stream, application/x-ndjson, application/json',
          }
        : {}),
    },
    body,
  };
}

// --- response parsing ------------------------------------------------------

function extractOpenAIResult(payload) {
  const choice = payload?.choices?.[0];
  const usage = payload?.usage;
  return {
    text: choice?.message?.content || '',
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    finish: choice?.finish_reason || null,
    model: payload?.model || null,
  };
}

function extractAnthropicResult(payload) {
  const text = (payload?.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
  return {
    text,
    inputTokens: payload?.usage?.input_tokens ?? null,
    outputTokens: payload?.usage?.output_tokens ?? null,
    finish: payload?.stop_reason || null,
    model: payload?.model || null,
  };
}

function makeOpenAIStreamConsumer(state) {
  let seenText = '';
  return (payload) => {
    if (typeof payload?.model === 'string' && payload.model) {
      state.model = payload.model;
    }
    if (payload?.usage) {
      state.inputTokens = payload.usage.prompt_tokens ?? state.inputTokens;
      state.outputTokens =
        payload.usage.completion_tokens ?? state.outputTokens;
    }
    const choice = payload?.choices?.[0];
    if (!choice) return;
    // Some backends stream cumulative `message` snapshots instead of deltas.
    const message = choice.message;
    if (typeof message?.content === 'string' && message.content) {
      const delta = message.content.startsWith(seenText)
        ? message.content.slice(seenText.length)
        : message.content;
      seenText = message.content;
      if (delta) state.onText(delta);
    }
    const delta = choice.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      seenText += delta.content;
      state.onText(delta.content);
    }
    const reasoning =
      delta?.reasoning_content ??
      delta?.reasoning ??
      message?.reasoning_content ??
      message?.reasoning;
    if (typeof reasoning === 'string' && reasoning) state.onThinking();
    if (choice.finish_reason) state.finish = choice.finish_reason;
  };
}

function makeAnthropicStreamConsumer(state) {
  return (payload) => {
    switch (payload?.type) {
      case 'message_start':
        state.model = payload.message?.model || state.model;
        state.inputTokens =
          payload.message?.usage?.input_tokens ?? state.inputTokens;
        break;
      case 'content_block_delta':
        if (payload.delta?.type === 'text_delta' && payload.delta.text) {
          state.onText(payload.delta.text);
        } else if (payload.delta?.type === 'thinking_delta') {
          state.onThinking();
        }
        break;
      case 'message_delta':
        state.outputTokens = payload.usage?.output_tokens ?? state.outputTokens;
        if (payload.delta?.stop_reason)
          state.finish = payload.delta.stop_reason;
        break;
      default:
        break;
    }
  };
}

// --- single measured request ----------------------------------------------

async function measureRequest(target, options, stream) {
  const { url, headers, body } = buildRequest(target, options, stream);
  const result = {
    arm: target.arm,
    label: target.label || target.arm,
    model: target.model,
    stream,
    status: null,
    ok: false,
    error: null,
    headersMs: null,
    firstByteMs: null,
    firstEventMs: null,
    firstThinkMs: null,
    firstTextMs: null,
    totalMs: null,
    inputTokens: null,
    outputTokens: null,
    finish: null,
    servedModel: null,
    replyChars: 0,
    replySnippet: '',
  };

  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.totalMs = since();
    return result;
  }
  result.headersMs = since();
  result.status = response.status;

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    result.error = `HTTP ${response.status}: ${text.slice(0, 300)}`;
    result.totalMs = since();
    return result;
  }

  try {
    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();
    const isEventStream =
      stream &&
      (contentType.includes('event-stream') || contentType.includes('ndjson'));
    if (!stream || !isEventStream) {
      const payload = await response.json();
      result.totalMs = since();
      const extracted =
        target.vendorKind === 'anthropic'
          ? extractAnthropicResult(payload)
          : extractOpenAIResult(payload);
      Object.assign(result, {
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        finish: extracted.finish,
        servedModel: extracted.model,
        replyChars: extracted.text.length,
        replySnippet: extracted.text.slice(0, 80),
        ok: true,
      });
      return result;
    }

    let replyText = '';
    const state = {
      model: null,
      inputTokens: null,
      outputTokens: null,
      finish: null,
      onText: (delta) => {
        if (result.firstTextMs === null) result.firstTextMs = since();
        replyText += delta;
      },
      onThinking: () => {
        if (result.firstThinkMs === null) result.firstThinkMs = since();
      },
    };
    const consume =
      target.vendorKind === 'anthropic'
        ? makeAnthropicStreamConsumer(state)
        : makeOpenAIStreamConsumer(state);

    const decoder = new TextDecoder();
    let buffer = '';
    const handleLine = (rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith(':')) return;
      if (trimmed.startsWith('event:') || trimmed.startsWith('id:')) return;
      const payloadText = trimmed.startsWith('data:')
        ? trimmed.slice(5).trim()
        : trimmed;
      if (!payloadText || payloadText === '[DONE]') return;
      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        return;
      }
      if (result.firstEventMs === null) result.firstEventMs = since();
      consume(payload);
    };

    for await (const chunk of response.body) {
      if (result.firstByteMs === null) result.firstByteMs = since();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);

    result.totalMs = since();
    Object.assign(result, {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      finish: state.finish,
      servedModel: state.model,
      replyChars: replyText.length,
      replySnippet: replyText.slice(0, 80),
      ok: true,
    });
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.totalMs = since();
    return result;
  }
}

// --- connection preflight ---------------------------------------------------

async function measureConnection(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname;
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const out = { origin: url.origin, dnsMs: null, tcpMs: null, tlsMs: null };

  const t0 = performance.now();
  let address = host;
  try {
    address = (await lookup(host)).address;
    out.dnsMs = Math.round(performance.now() - t0);
  } catch {
    return out;
  }

  const tcpStart = performance.now();
  const connected = await new Promise((resolve) => {
    const socket = net.connect({ host: address, port, family: 0 });
    socket.setTimeout(10_000, () => socket.destroy(new Error('timeout')));
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(null));
  });
  if (!connected) return out;
  out.tcpMs = Math.round(performance.now() - tcpStart);

  if (url.protocol === 'https:') {
    const tlsStart = performance.now();
    await new Promise((resolve) => {
      const secure = tls.connect({ socket: connected, servername: host });
      secure.setTimeout(10_000, () => secure.destroy(new Error('timeout')));
      secure.once('secureConnect', () => {
        out.tlsMs = Math.round(performance.now() - tlsStart);
        secure.end();
        resolve();
      });
      secure.once('error', () => resolve());
    });
  } else {
    connected.destroy();
  }
  return out;
}

// --- reporting --------------------------------------------------------------

function formatMs(value) {
  if (value === null || value === undefined) return '-';
  return `${value}`;
}

function median(values) {
  const sorted = values
    .filter((value) => typeof value === 'number')
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function tokensPerSecond(result) {
  // Only meaningful for streaming: non-streaming responses generate
  // server-side before any byte arrives, so no generation window is visible.
  if (!result.stream) return null;
  if (typeof result.outputTokens !== 'number' || result.outputTokens <= 0) {
    return null;
  }
  const start = result.firstTextMs ?? result.firstEventMs ?? result.headersMs;
  if (typeof start !== 'number' || typeof result.totalMs !== 'number') {
    return null;
  }
  const seconds = (result.totalMs - start) / 1000;
  if (seconds <= 0) return null;
  return Math.round((result.outputTokens / seconds) * 10) / 10;
}

function printTable(rows) {
  if (rows.length === 0) return;
  const headersRow = Object.keys(rows[0]);
  const widths = headersRow.map((header) =>
    Math.max(header.length, ...rows.map((row) => String(row[header]).length)),
  );
  const line = (cells) =>
    cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
  console.log(line(headersRow));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(Object.values(row)));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targets = resolveTargets(options);
  const streamModes =
    options.stream === 'both' ? [false, true] : [options.stream === 'true'];

  const active = [];
  for (const arm of options.arms) {
    const target = targets[arm];
    if (target.unsupported) {
      console.error(`[skip] ${arm}: ${target.unsupported}`);
      continue;
    }
    if (!target.token) {
      console.error(
        `[skip] ${target.label || arm}: missing credential (${target.missing})`,
      );
      continue;
    }
    if (arm === 'hai' && !target.chatbotId) {
      console.error(
        '[skip] hai: missing chatbot_id (set --chatbot-id, HYBRIDAI_CHATBOT_ID, or config.hybridai.defaultChatbotId)',
      );
      continue;
    }
    active.push(target);
  }
  if (active.length === 0) {
    console.error('No runnable arms. See skip notices above.');
    process.exit(1);
  }

  console.log(`prompt:      ${JSON.stringify(options.prompt)}`);
  console.log(
    `runs:        ${options.runs} per arm+stream (run 1 = cold connection)`,
  );
  console.log(
    `thinking:    ${options.thinking ? 'as HybridClaw sends it' : 'disabled'}`,
  );
  for (const target of active) {
    console.log(
      `${(target.label || target.arm).padEnd(15)}  ${target.model}  ->  ${target.url}`,
    );
  }
  console.log('');

  console.log('Connection preflight (fresh DNS + TCP + TLS per origin):');
  const preflight = [];
  for (const target of active) {
    preflight.push(await measureConnection(target.url));
  }
  printTable(
    preflight.map((entry) => ({
      origin: entry.origin,
      'dns ms': formatMs(entry.dnsMs),
      'tcp ms': formatMs(entry.tcpMs),
      'tls ms': formatMs(entry.tlsMs),
    })),
  );
  console.log('');

  const results = [];
  for (const target of active) {
    for (const stream of streamModes) {
      for (let run = 1; run <= options.runs; run += 1) {
        const label = `${target.label || target.arm} stream=${stream} run ${run}/${options.runs}`;
        process.stderr.write(`... ${label}\n`);
        const result = await measureRequest(target, options, stream);
        result.run = run;
        results.push(result);
        if (result.error) {
          console.error(`[fail] ${label}: ${result.error}`);
        } else if (options.verbose) {
          console.error(
            `       reply (${result.replyChars} chars): ${JSON.stringify(result.replySnippet)}`,
          );
        }
      }
    }
  }

  console.log('\nPer-run results (all times in ms from request start):');
  printTable(
    results.map((result) => ({
      arm: result.label,
      stream: result.stream ? 'on' : 'off',
      run: result.run,
      status: result.status ?? 'ERR',
      headers: formatMs(result.headersMs),
      '1st-event': formatMs(result.firstEventMs),
      '1st-think': formatMs(result.firstThinkMs),
      '1st-text': formatMs(result.firstTextMs),
      total: formatMs(result.totalMs),
      'tok in/out': `${result.inputTokens ?? '-'}/${result.outputTokens ?? '-'}`,
      'tok/s': tokensPerSecond(result) ?? '-',
    })),
  );

  console.log('\nMedians (successful runs only):');
  const summary = [];
  for (const target of active) {
    for (const stream of streamModes) {
      const subset = results.filter(
        (result) =>
          result.arm === target.arm && result.stream === stream && result.ok,
      );
      if (subset.length === 0) continue;
      summary.push({
        arm: target.label || target.arm,
        stream: stream ? 'on' : 'off',
        n: subset.length,
        headers: formatMs(median(subset.map((r) => r.headersMs))),
        '1st-text': formatMs(median(subset.map((r) => r.firstTextMs))),
        total: formatMs(median(subset.map((r) => r.totalMs))),
        'out tok': formatMs(median(subset.map((r) => r.outputTokens))),
        'tok/s': formatMs(median(subset.map((r) => tokensPerSecond(r)))),
      });
    }
  }
  printTable(summary);

  console.log(
    [
      '',
      'How to read this:',
      '  headers    time until HTTP status+headers arrived (network + auth + routing;',
      '             for non-streaming this is NOT completion time)',
      '  1st-text   streaming only: time until the first visible answer token',
      '             (gateway includes the full agent turn: system prompt build,',
      '             session setup, and any thinking before the reply)',
      '  total      full response received',
      '  tok/s      output tokens per second after the first text token',
      '             (streaming runs only)',
      '  gateway - hai   = HybridClaw overhead (agent loop, big system prompt, session)',
      '  hai - vendor    = HybridAI backend overhead (proxying, harness, queueing)',
    ].join('\n'),
  );

  if (options.jsonPath) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      options.jsonPath,
      JSON.stringify({ options, preflight, results }, null, 2),
    );
    console.log(`\nRaw results written to ${options.jsonPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
