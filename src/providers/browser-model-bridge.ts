import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import WebSocket, * as wsModule from 'ws';
import {
  buildBrowserBridgeHtml,
  serveBrowserBridgeAsset,
} from './browser-model-bridge-page.js';

export const DEFAULT_BROWSER_MODEL_BRIDGE_MODEL = 'LiquidAI/LFM2.5-230M-ONNX';
export const DEFAULT_BROWSER_MODEL_BRIDGE_HOST = '127.0.0.1';
export const DEFAULT_BROWSER_MODEL_BRIDGE_PORT = 8789;
export const DEFAULT_BROWSER_MODEL_BRIDGE_DEVICE = 'webgpu';
export const DEFAULT_BROWSER_MODEL_BRIDGE_DTYPE = 'q4f16';
export const DEFAULT_BROWSER_MODEL_BRIDGE_MAX_NEW_TOKENS = 2048;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15 * 60_000;

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

type BridgeStatus = {
  connected: boolean;
  state: 'idle' | 'loading' | 'ready' | 'generating' | 'error';
  message: string;
  progress?: number;
  error?: string;
};

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
  payload: unknown,
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
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url || '/', 'http://127.0.0.1');
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractBearerToken(req: IncomingMessage): string {
  const value = req.headers.authorization;
  const header = Array.isArray(value) ? value[0] : value;
  const match = String(header || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function checkApiKey(req: IncomingMessage, apiKey: string): boolean {
  if (!apiKey) return true;
  return extractBearerToken(req) === apiKey;
}

function createModelList(model: string): Record<string, unknown> {
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
}): Record<string, unknown> {
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
    pending.res.write(
      ssePayload(
        pending.id,
        pending.model,
        pending.created,
        { content: message },
        'stop',
      ),
    );
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
      serveBrowserBridgeAsset(res, path.basename(url.pathname));
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

      let body: unknown;
      try {
        body = safeJsonParse(await readRequestBody(req));
      } catch (error) {
        jsonResponse(res, 413, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'invalid_request_error',
          },
        });
        return;
      }
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
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    if (activeBrowser && activeBrowser.readyState === WebSocket.OPEN) {
      activeBrowser.close(1000, 'Another bridge tab connected.');
    }
    activeBrowser = ws;
    status.connected = true;
    status.state = 'idle';
    status.message = 'connected';

    ws.on('message', (raw) => {
      const payload = safeJsonParse(String(raw));
      if (!isRecord(payload)) return;
      const type = typeof payload.type === 'string' ? payload.type : '';
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
        failPendingRequest(
          pending,
          500,
          String(payload.error || 'Browser generation failed.'),
        );
      }
    });

    ws.on('close', () => {
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
