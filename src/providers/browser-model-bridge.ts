import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, * as wsModule from 'ws';
import {
  writeLastPromptDebugText,
  writeModelResponseDebugText,
} from '../infra/model-response-debug.js';
import { logger } from '../logger.js';
import {
  buildBrowserBridgeHtml,
  buildBrowserBridgeWorkerScript,
  serveBrowserBridgeAsset,
} from './browser-model-bridge-page.js';

export const DEFAULT_BROWSER_MODEL_BRIDGE_MODEL = 'LiquidAI/LFM2.5-230M-ONNX';
export const DEFAULT_BROWSER_MODEL_BRIDGE_HOST = '127.0.0.1';
export const DEFAULT_BROWSER_MODEL_BRIDGE_PORT = 8789;
export const DEFAULT_BROWSER_MODEL_BRIDGE_DEVICE = 'webgpu';
export const DEFAULT_BROWSER_MODEL_BRIDGE_DTYPE = 'q4';
export const DEFAULT_BROWSER_MODEL_BRIDGE_MAX_NEW_TOKENS = 256;
const LFM_WEBGPU_DTYPES = new Set(['q4', 'fp16']);
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15 * 60_000;
const REQUEST_BODY_TOO_LARGE_MESSAGE = 'Request body is too large.';
const REQUEST_BODY_READ_FAILED_MESSAGE = 'Unable to read request body.';

type WebSocketServerLike = {
  on: (
    event: 'connection',
    listener: (socket: WebSocket, req: IncomingMessage) => void,
  ) => void;
  handleUpgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (socket: WebSocket) => void,
  ) => void;
  emit: (
    event: 'connection',
    socket: WebSocket,
    req: IncomingMessage,
  ) => boolean;
  close: () => void;
};

const WebSocketServerCtor = (
  wsModule as unknown as {
    WebSocketServer: new (options: { noServer: true }) => WebSocketServerLike;
  }
).WebSocketServer;

export interface BrowserModelBridgeOptions {
  model?: string;
  host?: string;
  port?: number;
  device?: string;
  dtype?: string;
  apiKey?: string;
  maxNewTokens?: number;
}

export interface BrowserModelBridgeHandle {
  host: string;
  port: number;
  model: string;
  device: string;
  dtype: string;
  maxNewTokens: number;
  pageUrl: string;
  endpointUrl: string;
  close: () => Promise<void>;
}

type PendingRequest = {
  id: string;
  model: string;
  stream: boolean;
  // True when the response is buffered rather than streamed as text, so it can
  // be parsed into OpenAI tool_calls at completion: forced LFM turns, and Gemma
  // models (which emit `call:name{...}` we must convert).
  buffered: boolean;
  res: ServerResponse;
  content: string;
  created: number;
  timeout: NodeJS.Timeout;
};

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

type BridgeStatus = {
  connected: boolean;
  state: 'idle' | 'loading' | 'ready' | 'generating' | 'error';
  message: string;
  progress?: number;
  error?: string;
};

type RequestBodyReadResult =
  | { ok: true; body: string }
  | { ok: false; reason: 'too_large' | 'read_failed' };

function normalizeHost(value: string | undefined): string {
  return String(value || '').trim() || DEFAULT_BROWSER_MODEL_BRIDGE_HOST;
}

function normalizeModel(value: string | undefined): string {
  return String(value || '').trim() || DEFAULT_BROWSER_MODEL_BRIDGE_MODEL;
}

function isLiquidBrowserModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.includes('liquidai') ||
    normalized.includes('/liquid/') ||
    normalized.includes('lfm')
  );
}

function isGemmaBrowserModel(model: string): boolean {
  return model.trim().toLowerCase().includes('gemma');
}

export function normalizeBrowserModelBridgeDtype(params: {
  model: string;
  device: string;
  dtype: string;
}): string {
  const dtype = params.dtype.trim() || DEFAULT_BROWSER_MODEL_BRIDGE_DTYPE;
  if (
    params.device.trim().toLowerCase() === 'webgpu' &&
    isLiquidBrowserModel(params.model) &&
    !LFM_WEBGPU_DTYPES.has(dtype)
  ) {
    throw new Error(
      `LiquidAI LFM WebGPU models support only q4 or fp16 quantization, not ${dtype}.`,
    );
  }
  return dtype;
}

function normalizePort(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BROWSER_MODEL_BRIDGE_PORT;
  }
  const port = Math.floor(value);
  if (port < 0 || port > 65_535) return DEFAULT_BROWSER_MODEL_BRIDGE_PORT;
  return port;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function jsonResponse(
  res: ServerResponse,
  statusCode: number,
  payload: JsonValue,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

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

function writeCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader(
    'access-control-allow-headers',
    'authorization, content-type, accept',
  );
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-embedder-policy', 'require-corp');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url || '/', 'http://127.0.0.1');
}

function readRequestBody(req: IncomingMessage): Promise<RequestBodyReadResult> {
  return new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        failed = true;
        chunks.length = 0;
        resolve({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      resolve({ ok: true, body: Buffer.concat(chunks).toString('utf-8') });
    });
    req.on('error', () => {
      if (failed) return;
      failed = true;
      resolve({ ok: false, reason: 'read_failed' });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractBearerToken(req: IncomingMessage): string {
  const value = req.headers.authorization;
  const header = Array.isArray(value) ? value[0] : value;
  const authorization = String(header || '');
  if (authorization.slice(0, 6).toLowerCase() !== 'bearer') return '';
  const separator = authorization.charCodeAt(6);
  if (separator !== 0x20 && separator !== 0x09) return '';
  return authorization.slice(7).trim();
}

function checkApiKey(req: IncomingMessage, apiKey: string): boolean {
  if (!apiKey) return true;
  return extractBearerToken(req) === apiKey;
}

function createModelList(model: string): JsonObject {
  return {
    object: 'list',
    data: [
      {
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'browser',
      },
    ],
  };
}

const LIQUID_TOOL_CALL_START = '<|tool_call_start|>';
const LIQUID_TOOL_CALL_END = '<|tool_call_end|>';

function lastMessageRole(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && typeof message.role === 'string') {
      return message.role;
    }
  }
  return '';
}

// LFM2 models reliably emit a tool call when the assistant turn is prefilled
// with the `<|tool_call_start|>[` marker, but the small browser models will not
// choose to start one on their own. Force the prefix when the caller requires a
// tool (`tool_choice`) or when it is the model's turn to act on a user request.
// The marker is Liquid-specific, so only force it for LFM/Liquid models — other
// families (e.g. Gemma) use a different tool-call syntax and must not get it.
export function computeForcedToolPrefix(
  body: Record<string, unknown>,
  model: string,
): string {
  if (!isLiquidBrowserModel(model)) return '';
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length === 0) return '';
  const choice = body.tool_choice;
  if (choice === 'none') return '';
  if (
    isRecord(choice) &&
    isRecord(choice.function) &&
    typeof choice.function.name === 'string' &&
    choice.function.name
  ) {
    return `${LIQUID_TOOL_CALL_START}[${choice.function.name}(`;
  }
  if (choice === 'required') return `${LIQUID_TOOL_CALL_START}[`;
  if (lastMessageRole(body.messages) === 'user') {
    return `${LIQUID_TOOL_CALL_START}[`;
  }
  return '';
}

function splitTopLevelSegments(text: string, separator: string): string[] {
  const segments: string[] = [];
  const stack: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let current = '';
  for (const char of text) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') stack.push(char);
    else if (char === ')' || char === ']' || char === '}') stack.pop();
    if (char === separator && stack.length === 0) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current);
  return segments;
}

function parseLiquidArgValue(raw: string): JsonValue {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const inner = trimmed.slice(1, -1);
    if (first === '"') {
      try {
        return JSON.parse(trimmed) as JsonValue;
      } catch {
        return inner;
      }
    }
    return inner.replace(/\\'/g, "'");
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === 'None') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed) as JsonValue;
    } catch {
      // Gemma renders nested objects unquoted ({command:ls -la}); parse them
      // recursively so dispatcher arguments survive as real JSON.
      const object: JsonObject = {};
      for (const pair of splitTopLevelSegments(trimmed.slice(1, -1), ',')) {
        const colon = pair.indexOf(':');
        if (colon < 1) continue;
        const key = pair
          .slice(0, colon)
          .trim()
          .replace(/^["']|["']$/g, '');
        if (!key) continue;
        object[key] = parseLiquidArgValue(pair.slice(colon + 1));
      }
      return object;
    }
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return JSON.parse(trimmed) as JsonValue;
    } catch {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) return [];
      return splitTopLevelSegments(inner, ',').map((item) =>
        parseLiquidArgValue(item),
      );
    }
  }
  return trimmed;
}

function parseLiquidCallSegment(segment: string): JsonObject | null {
  const match = segment
    .trim()
    .match(/^([A-Za-z_][A-Za-z0-9_.-]*)\(([\s\S]*)\)$/);
  if (!match) return null;
  const name = (match[1] || '').replace(/^tools\./, '');
  const argsText = (match[2] || '').trim();
  const args: JsonObject = {};
  if (argsText) {
    for (const assignment of splitTopLevelSegments(argsText, ',')) {
      const eq = assignment.indexOf('=');
      if (eq < 1) continue;
      const key = assignment.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
      args[key] = parseLiquidArgValue(assignment.slice(eq + 1));
    }
  }
  return {
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

// Extract LFM2 native tool calls (`<|tool_call_start|>[fn(k=v), ...]<|tool_call_end|>`)
// from streamed text into OpenAI tool_calls, returning the remaining prose.
export function parseLiquidToolCalls(text: string): {
  content: string;
  toolCalls: JsonObject[];
} {
  const start = text.indexOf(LIQUID_TOOL_CALL_START);
  if (start < 0) return { content: text, toolCalls: [] };
  const payloadStart = start + LIQUID_TOOL_CALL_START.length;
  const endIndex = text.indexOf(LIQUID_TOOL_CALL_END, payloadStart);
  const payloadEnd = endIndex < 0 ? text.length : endIndex;
  let payload = text.slice(payloadStart, payloadEnd).trim();
  if (payload.startsWith('[') && payload.endsWith(']')) {
    payload = payload.slice(1, -1).trim();
  } else if (payload.startsWith('[')) {
    payload = payload.slice(1).trim();
  }
  const toolCalls = splitTopLevelSegments(payload, ',')
    .map((segment) => parseLiquidCallSegment(segment))
    .filter((call): call is JsonObject => call !== null);
  if (toolCalls.length === 0) return { content: text, toolCalls: [] };
  const trailing =
    endIndex < 0 ? '' : text.slice(endIndex + LIQUID_TOOL_CALL_END.length);
  const content = (text.slice(0, start) + trailing).trim();
  return { content, toolCalls };
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripRanges(
  text: string,
  ranges: Array<{ start: number; end: number }>,
): string {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  let result = '';
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue;
    result += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return result + text.slice(cursor);
}

// Gemma emits Pythonic-ish calls `call:name{key:value, ...}`. The model's
// `<|tool_call>`/`<|"|>` markers are stripped by skip_special_tokens, so string
// values arrive unquoted (e.g. `command:ls -la`). Parse those into OpenAI
// tool_calls, leaving any surrounding prose as content.
export function parseGemmaToolCalls(text: string): {
  content: string;
  toolCalls: JsonObject[];
} {
  const toolCalls: JsonObject[] = [];
  const removals: Array<{ start: number; end: number }> = [];
  const callRegex = /call:([A-Za-z_][A-Za-z0-9_.-]*)\s*\{/g;
  let match: RegExpExecArray | null = callRegex.exec(text);
  while (match !== null) {
    const braceOpen = match.index + match[0].length - 1;
    const braceClose = findMatchingBrace(text, braceOpen);
    if (braceClose < 0) break;
    const name = (match[1] || '').replace(/^tools\./, '');
    const argsText = text.slice(braceOpen + 1, braceClose).trim();
    const args: JsonObject = {};
    for (const pair of splitTopLevelSegments(argsText, ',')) {
      const colon = pair.indexOf(':');
      if (colon < 1) continue;
      const key = pair.slice(0, colon).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
      args[key] = parseLiquidArgValue(pair.slice(colon + 1));
    }
    toolCalls.push({
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    removals.push({ start: match.index, end: braceClose + 1 });
    callRegex.lastIndex = braceClose + 1;
    match = callRegex.exec(text);
  }
  if (toolCalls.length === 0) return { content: text, toolCalls: [] };
  return { content: stripRanges(text, removals).trim(), toolCalls };
}

// Dispatch tool-call parsing by model family: LFM uses the bracketed
// `<|tool_call_start|>` form, Gemma uses `call:name{...}`. Unknown families pass
// their content through unparsed.
export function parseBrowserToolCalls(
  model: string,
  text: string,
): { content: string; toolCalls: JsonObject[] } {
  if (isLiquidBrowserModel(model)) return parseLiquidToolCalls(text);
  if (isGemmaBrowserModel(model)) return parseGemmaToolCalls(text);
  return { content: text, toolCalls: [] };
}

function toolCallsStreamDelta(
  toolCalls: JsonObject[],
): Record<string, unknown> {
  return {
    tool_calls: toolCalls.map((call, index) => ({
      index,
      id: call.id,
      type: 'function',
      function: call.function,
    })),
  };
}

function createChatCompletion(params: {
  id: string;
  model: string;
  content: string;
  created: number;
  toolCalls?: JsonObject[];
}): JsonObject {
  const hasToolCalls = !!params.toolCalls && params.toolCalls.length > 0;
  return {
    id: params.id,
    object: 'chat.completion',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: hasToolCalls && !params.content ? null : params.content,
          ...(hasToolCalls ? { tool_calls: params.toolCalls } : {}),
        },
        finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function ssePayload(
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: Record<string, number>,
): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

function sseErrorPayload(message: string): string {
  return `data: ${JSON.stringify({
    error: {
      message,
      type: 'browser_bridge_error',
    },
  })}\n\n`;
}

function writeSseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sendWebSocket(
  socket: WebSocket | null,
  payload: Record<string, unknown>,
): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function failPendingRequest(
  pending: PendingRequest,
  statusCode: number,
  message: string,
): void {
  clearTimeout(pending.timeout);
  if (pending.stream) {
    if (!pending.res.headersSent) writeSseHeaders(pending.res);
    pending.res.write(sseErrorPayload(message));
    pending.res.write('data: [DONE]\n\n');
    pending.res.end();
    return;
  }
  jsonResponse(pending.res, statusCode, {
    error: {
      message,
      type: 'browser_bridge_error',
    },
  });
}

function writeBrowserModelDebugRecord(params: {
  message: string;
  model: string;
  data: unknown;
}): void {
  if (params.message === 'Debug model request') {
    writeLastPromptDebugText(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        provider: 'browser',
        model: params.model,
        kind: 'browser_bridge_rendered_prompt',
        request: params.data,
      })}\n`,
    );
    return;
  }

  if (params.message !== 'Debug model response') return;
  writeModelResponseDebugText(
    `[model-response-debug] ${JSON.stringify({
      provider: 'browser',
      model: params.model,
      kind: 'browser_bridge_worker_response',
      response: params.data,
    })}\n`,
  );
}

export async function startBrowserModelBridge(
  options: BrowserModelBridgeOptions = {},
): Promise<BrowserModelBridgeHandle> {
  const model = normalizeModel(options.model);
  const host = normalizeHost(options.host);
  const requestedPort = normalizePort(options.port);
  const device =
    String(options.device || '').trim() || DEFAULT_BROWSER_MODEL_BRIDGE_DEVICE;
  const dtype = normalizeBrowserModelBridgeDtype({
    model,
    device,
    dtype: String(options.dtype || ''),
  });
  const apiKey = String(options.apiKey || '').trim();
  const maxNewTokens = normalizePositiveInteger(
    options.maxNewTokens,
    DEFAULT_BROWSER_MODEL_BRIDGE_MAX_NEW_TOKENS,
  );

  let activeBrowser: WebSocket | null = null;
  const pendingRequests = new Map<string, PendingRequest>();
  const status: BridgeStatus = {
    connected: false,
    state: 'idle',
    message: 'idle',
  };

  const wss = new WebSocketServerCtor({ noServer: true });
  const server = http.createServer(async (req, res) => {
    writeCorsHeaders(res);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = parseUrl(req);
    if (method === 'GET' && url.pathname === '/bridge/worker.js') {
      textResponse(
        res,
        200,
        buildBrowserBridgeWorkerScript(),
        'text/javascript; charset=utf-8',
      );
      return;
    }
    if (method === 'GET' && url.pathname === '/') {
      textResponse(
        res,
        200,
        buildBrowserBridgeHtml({ model, device, dtype, maxNewTokens }),
        'text/html; charset=utf-8',
      );
      return;
    }
    if (method === 'GET' && url.pathname.startsWith('/vendor/')) {
      logger.debug(
        { assetPath: url.pathname },
        'Browser model bridge serving vendor asset',
      );
      serveBrowserBridgeAsset(res, url.pathname);
      return;
    }
    if (method === 'GET' && url.pathname === '/health') {
      jsonResponse(res, 200, {
        ok: true,
        model,
        browser: status,
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/models') {
      if (!checkApiKey(req, apiKey)) {
        jsonResponse(res, 401, {
          error: { message: 'Unauthorized', type: 'authentication_error' },
        });
        return;
      }
      jsonResponse(res, 200, createModelList(model));
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (!checkApiKey(req, apiKey)) {
        jsonResponse(res, 401, {
          error: { message: 'Unauthorized', type: 'authentication_error' },
        });
        return;
      }
      if (!activeBrowser || activeBrowser.readyState !== WebSocket.OPEN) {
        jsonResponse(res, 503, {
          error: {
            message:
              'No browser tab is connected. Open the bridge page and keep it active.',
            type: 'browser_bridge_unavailable',
          },
        });
        return;
      }

      const requestBody = await readRequestBody(req);
      if (!requestBody.ok) {
        const bodyTooLarge = requestBody.reason === 'too_large';
        jsonResponse(res, bodyTooLarge ? 413 : 400, {
          error: {
            message: bodyTooLarge
              ? REQUEST_BODY_TOO_LARGE_MESSAGE
              : REQUEST_BODY_READ_FAILED_MESSAGE,
            type: 'invalid_request_error',
          },
        });
        return;
      }
      const body = safeJsonParse(requestBody.body);
      if (!isRecord(body) || !Array.isArray(body.messages)) {
        jsonResponse(res, 400, {
          error: {
            message: '`messages` must be an array.',
            type: 'invalid_request_error',
          },
        });
        return;
      }

      const id = `chatcmpl-${randomUUID()}`;
      const stream = body.stream === true;
      const created = Math.floor(Date.now() / 1000);
      const forcedToolPrefix = computeForcedToolPrefix(body, model);
      const pending: PendingRequest = {
        id,
        model:
          typeof body.model === 'string' && body.model ? body.model : model,
        stream,
        buffered: forcedToolPrefix.length > 0 || isGemmaBrowserModel(model),
        res,
        content: '',
        created,
        timeout: setTimeout(() => {
          pendingRequests.delete(id);
          failPendingRequest(pending, 504, 'Browser model request timed out.');
        }, REQUEST_TIMEOUT_MS),
      };
      pendingRequests.set(id, pending);
      res.on('close', () => {
        if (res.writableEnded) return;
        pendingRequests.delete(id);
      });
      if (stream) {
        writeSseHeaders(res);
        res.write(
          ssePayload(id, pending.model, created, { role: 'assistant' }, null),
        );
      }
      const sent = sendWebSocket(activeBrowser, {
        type: 'generate',
        id,
        request: {
          ...body,
          model,
          ...(forcedToolPrefix
            ? { force_assistant_prefix: forcedToolPrefix }
            : {}),
        },
      });
      if (!sent) {
        pendingRequests.delete(id);
        failPendingRequest(
          pending,
          503,
          'No browser tab is connected. Open the bridge page and keep it active.',
        );
      }
      return;
    }

    textResponse(res, 404, 'Not found');
  });

  server.on('upgrade', (req, socket, head) => {
    const url = parseUrl(req);
    if (url.pathname !== '/bridge/ws') {
      logger.debug(
        { pathname: url.pathname },
        'Browser model bridge rejected websocket upgrade',
      );
      socket.destroy();
      return;
    }
    logger.debug(
      { remoteAddress: req.socket.remoteAddress },
      'Browser model bridge websocket upgrade',
    );
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    if (activeBrowser && activeBrowser.readyState === WebSocket.OPEN) {
      activeBrowser.close(1000, 'Another bridge tab connected.');
    }
    activeBrowser = ws;
    status.connected = true;
    status.state = 'idle';
    status.message = 'connected';
    logger.debug(
      { remoteAddress: req.socket.remoteAddress },
      'Browser model bridge tab connected',
    );

    ws.on('message', (raw) => {
      const payload = safeJsonParse(String(raw));
      if (!isRecord(payload)) return;
      const type = typeof payload.type === 'string' ? payload.type : '';
      if (type === 'hello') {
        logger.debug(
          {
            model: typeof payload.model === 'string' ? payload.model : null,
            device: typeof payload.device === 'string' ? payload.device : null,
            dtype: typeof payload.dtype === 'string' ? payload.dtype : null,
          },
          'Browser model bridge tab hello',
        );
        return;
      }
      if (type === 'status') {
        const state = String(payload.state || '').trim();
        if (
          state === 'idle' ||
          state === 'loading' ||
          state === 'ready' ||
          state === 'generating' ||
          state === 'error'
        ) {
          status.state = state;
        }
        status.message = String(payload.message || status.state);
        if (typeof payload.progress === 'number') {
          status.progress = payload.progress;
        }
        logger.debug(
          {
            state: status.state,
            message: status.message,
            progress: status.progress,
          },
          'Browser model bridge status update',
        );
        return;
      }
      if (type === 'log') {
        const message =
          typeof payload.message === 'string' ? payload.message : null;
        writeBrowserModelDebugRecord({
          message: message || '',
          model,
          data: payload.data ?? null,
        });
        logger.debug(
          {
            message,
            data: payload.data ?? null,
          },
          'Browser model bridge page log',
        );
        return;
      }

      const id = typeof payload.id === 'string' ? payload.id : '';
      const pending = id ? pendingRequests.get(id) : undefined;
      if (!pending) return;
      if (type === 'delta') {
        const delta = String(payload.delta || '');
        if (!delta) return;
        pending.content += delta;
        // Forced turns are buffered and emitted as structured tool_calls on
        // completion; only stream plain-text deltas for non-buffered turns.
        if (pending.stream && !pending.buffered && !pending.res.writableEnded) {
          pending.res.write(
            ssePayload(
              pending.id,
              pending.model,
              pending.created,
              { content: delta },
              null,
            ),
          );
        }
        return;
      }
      if (type === 'complete') {
        pendingRequests.delete(id);
        clearTimeout(pending.timeout);
        const content =
          typeof payload.content === 'string'
            ? payload.content
            : pending.content;
        const usage = {
          prompt_tokens: 0,
          completion_tokens:
            typeof payload.tokens === 'number' ? payload.tokens : 0,
          total_tokens: typeof payload.tokens === 'number' ? payload.tokens : 0,
        };
        if (pending.stream) {
          const { content: cleanedContent, toolCalls } = parseBrowserToolCalls(
            model,
            content,
          );
          if (toolCalls.length > 0) {
            pending.res.write(
              ssePayload(
                pending.id,
                pending.model,
                pending.created,
                toolCallsStreamDelta(toolCalls),
                null,
              ),
            );
            pending.res.write(
              ssePayload(
                pending.id,
                pending.model,
                pending.created,
                {},
                'tool_calls',
                usage,
              ),
            );
          } else {
            // No tool call parsed: flush any buffered text, then stop.
            if (pending.buffered && cleanedContent) {
              pending.res.write(
                ssePayload(
                  pending.id,
                  pending.model,
                  pending.created,
                  { content: cleanedContent },
                  null,
                ),
              );
            }
            pending.res.write(
              ssePayload(
                pending.id,
                pending.model,
                pending.created,
                {},
                'stop',
                usage,
              ),
            );
          }
          pending.res.write('data: [DONE]\n\n');
          pending.res.end();
        } else {
          const { content: cleanedContent, toolCalls } = parseBrowserToolCalls(
            model,
            content,
          );
          jsonResponse(
            pending.res,
            200,
            createChatCompletion({
              id: pending.id,
              model: pending.model,
              content: cleanedContent,
              created: pending.created,
              toolCalls,
            }),
          );
        }
        return;
      }
      if (type === 'error') {
        pendingRequests.delete(id);
        logger.debug(
          {
            error: payload.error,
            details: payload.details,
          },
          'Browser model bridge generation failed',
        );
        failPendingRequest(
          pending,
          500,
          String(payload.error || 'Browser generation failed.'),
        );
      }
    });

    ws.on('error', (err) => {
      logger.debug({ err }, 'Browser model bridge websocket error');
    });

    ws.on('close', (code, reason) => {
      logger.debug(
        { code, reason: reason.toString() },
        'Browser model bridge tab disconnected',
      );
      if (activeBrowser !== ws) return;
      activeBrowser = null;
      status.connected = false;
      status.state = 'idle';
      status.message = 'disconnected';
      for (const pending of pendingRequests.values()) {
        failPendingRequest(
          pending,
          503,
          'Browser tab disconnected before generation completed.',
        );
      }
      pendingRequests.clear();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port =
    typeof address === 'object' && address ? address.port : requestedPort;
  const baseUrl = `http://${host}:${port}`;

  return {
    host,
    port,
    model,
    device,
    dtype,
    maxNewTokens,
    pageUrl: `${baseUrl}/`,
    endpointUrl: `${baseUrl}/v1`,
    close: () =>
      new Promise((resolve) => {
        for (const pending of pendingRequests.values()) {
          failPendingRequest(pending, 503, 'Browser bridge is shutting down.');
        }
        pendingRequests.clear();
        activeBrowser?.close(1001, 'Bridge shutting down.');
        wss.close();
        server.close(() => resolve());
      }),
  };
}
