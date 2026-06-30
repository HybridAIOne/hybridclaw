import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, * as wsModule from 'ws';
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

function createChatCompletion(params: {
  id: string;
  model: string;
  content: string;
  created: number;
}): JsonObject {
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
          content: params.content,
        },
        finish_reason: 'stop',
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

export async function startBrowserModelBridge(
  options: BrowserModelBridgeOptions = {},
): Promise<BrowserModelBridgeHandle> {
  const model = normalizeModel(options.model);
  const host = normalizeHost(options.host);
  const requestedPort = normalizePort(options.port);
  const device =
    String(options.device || '').trim() || DEFAULT_BROWSER_MODEL_BRIDGE_DEVICE;
  const dtype =
    String(options.dtype || '').trim() || DEFAULT_BROWSER_MODEL_BRIDGE_DTYPE;
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
      const pending: PendingRequest = {
        id,
        model:
          typeof body.model === 'string' && body.model ? body.model : model,
        stream,
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
        logger.debug(
          {
            message:
              typeof payload.message === 'string' ? payload.message : null,
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
        if (pending.stream && !pending.res.writableEnded) {
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
        if (pending.stream) {
          pending.res.write(
            ssePayload(pending.id, pending.model, pending.created, {}, 'stop', {
              prompt_tokens: 0,
              completion_tokens:
                typeof payload.tokens === 'number' ? payload.tokens : 0,
              total_tokens:
                typeof payload.tokens === 'number' ? payload.tokens : 0,
            }),
          );
          pending.res.write('data: [DONE]\n\n');
          pending.res.end();
        } else {
          jsonResponse(
            pending.res,
            200,
            createChatCompletion({
              id: pending.id,
              model: pending.model,
              content,
              created: pending.created,
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
