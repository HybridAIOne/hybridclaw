/**
 * Taking over the agent's browser from the owner's phone.
 *
 * The container's `browser_take_over` tool opens a take-over for its chat with
 * the port of agent-browser's own stream server (frames out, input in) and
 * waits. The phone asks for a single-use stream token by chat
 * (`/api/browser/take-over/connect`), opens `TAKE_OVER_STREAM_PATH`, and
 * the gateway relays between the two. When the user is done, the phone says so
 * (`/api/browser/take-over/finish`), with or without "remember how I did
 * that", and the tool returns.
 *
 * The stream server listens on the worker's loopback, so this needs host
 * sandbox mode, where the worker shares the gateway's network.
 *
 * Only the fields below cross the relay, in both directions: picture frames
 * and the active tab's address go out, mouse, keyboard and touch input comes
 * in. agent-browser's other messages (its command log, console output) never
 * reach the phone.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, * as wsModule from 'ws';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { getResolvedSandboxMode } from '../config/config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { logger } from '../logger.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';

export const TAKE_OVER_OPEN_PATH = '/api/browser/take-over';
export const TAKE_OVER_STATUS_PATH = '/api/browser/take-over/status';
export const TAKE_OVER_CLOSE_PATH = '/api/browser/take-over/close';
export const TAKE_OVER_CONNECT_PATH = '/api/browser/take-over/connect';
export const TAKE_OVER_FINISH_PATH = '/api/browser/take-over/finish';
export const TAKE_OVER_STREAM_PATH = '/api/browser/take-over/stream';

// Grok Bot's "Teach a task" records up to 10 minutes; so does this.
const TAKE_OVER_TTL_MS = 10 * 60_000;
const STREAM_TOKEN_TTL_MS = 60_000;
const MAX_TAKE_OVERS = 8;
// A frame is one JPEG of the viewport; a phone that falls behind skips some.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 4 * 1024;

type TakeOverState = 'waiting' | 'active' | 'finished';

interface TakeOver {
  id: string;
  sessionId: string;
  port: number;
  reason: string;
  expiresAt: number;
  state: TakeOverState;
  remember: boolean;
  client: WebSocket | null;
  upstream: WebSocket | null;
}

const takeOvers = new Map<string, TakeOver>();
const streamTokens = new Map<string, { id: string; expiresAt: number }>();

export interface TakeOverAuditContext {
  actor?: string | null;
  sourceIp?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function prune(): void {
  const now = Date.now();
  for (const takeOver of takeOvers.values()) {
    if (takeOver.expiresAt <= now) end(takeOver);
  }
  for (const [token, entry] of streamTokens) {
    if (entry.expiresAt <= now || !takeOvers.has(entry.id)) {
      streamTokens.delete(token);
    }
  }
}

function disconnect(takeOver: TakeOver): void {
  takeOver.client?.close(1000, 'Take-over ended');
  takeOver.upstream?.close();
  takeOver.client = null;
  takeOver.upstream = null;
}

function end(takeOver: TakeOver): void {
  takeOvers.delete(takeOver.id);
  takeOver.state = 'finished';
  disconnect(takeOver);
}

function audit(
  type: 'browser.take_over_started' | 'browser.take_over_finished',
  takeOver: TakeOver,
  context: TakeOverAuditContext,
): void {
  recordAuditEvent({
    sessionId: takeOver.sessionId,
    runId: makeAuditRunId('take-over'),
    event: {
      type,
      takeOverId: takeOver.id,
      actor: context.actor || null,
      sourceIp: context.sourceIp || null,
      ...(type === 'browser.take_over_finished'
        ? { remember: takeOver.remember }
        : {}),
    },
  });
}

function requireTakeOver(raw: unknown): TakeOver {
  prune();
  const takeOver = takeOvers.get(text(raw, 64));
  if (!takeOver) throw new GatewayRequestError(404, 'No such take-over.');
  return takeOver;
}

/** The worker's routes, called with the gateway token. */
export async function handleApiTakeOverRuntime(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const body = asRecord(await readJsonBody(req));
  if (pathname === TAKE_OVER_OPEN_PATH) {
    if (getResolvedSandboxMode() !== 'host') {
      throw new GatewayRequestError(
        409,
        'Taking over the browser needs the host sandbox mode.',
      );
    }
    const sessionId = text(body.sessionId, 256);
    const port = Number(body.port);
    if (!sessionId || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new GatewayRequestError(400, 'Expected sessionId and port.');
    }
    prune();
    // One take-over per chat: a new one replaces what is left of the last.
    for (const existing of takeOvers.values()) {
      if (existing.sessionId === sessionId) end(existing);
    }
    if (takeOvers.size >= MAX_TAKE_OVERS) {
      throw new GatewayRequestError(429, 'Too many open take-overs.');
    }
    const takeOver: TakeOver = {
      id: randomUUID(),
      sessionId,
      port,
      reason: text(body.reason, 300),
      expiresAt: Date.now() + TAKE_OVER_TTL_MS,
      state: 'waiting',
      remember: false,
      client: null,
      upstream: null,
    };
    takeOvers.set(takeOver.id, takeOver);
    sendJson(res, 200, {
      id: takeOver.id,
      expiresInSeconds: TAKE_OVER_TTL_MS / 1000,
    });
    return;
  }
  if (pathname === TAKE_OVER_STATUS_PATH) {
    prune();
    const takeOver = takeOvers.get(text(body.id, 64));
    // Gone means finished: by time, or by a newer take-over in the chat.
    sendJson(res, 200, {
      state: takeOver?.state ?? 'finished',
      remember: takeOver?.remember ?? false,
    });
    return;
  }
  if (pathname === TAKE_OVER_CLOSE_PATH) {
    const takeOver = takeOvers.get(text(body.id, 64));
    if (takeOver) end(takeOver);
    sendJson(res, 200, { closed: true });
    return;
  }
  throw new GatewayRequestError(404, 'Not Found');
}

/** The phone's routes, called with a token that may control the browser. */
export async function handleApiTakeOver(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  context: TakeOverAuditContext,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const body = asRecord(await readJsonBody(req));
  if (pathname === TAKE_OVER_CONNECT_PATH) {
    const sessionId = text(body.sessionId, 256);
    prune();
    const takeOver = [...takeOvers.values()].find(
      (candidate) =>
        candidate.sessionId === sessionId && candidate.state !== 'finished',
    );
    if (!takeOver) {
      throw new GatewayRequestError(404, 'Nothing to take over in this chat.');
    }
    const token = randomBytes(24).toString('base64url');
    streamTokens.set(token, {
      id: takeOver.id,
      expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
    });
    if (takeOver.state === 'waiting')
      audit('browser.take_over_started', takeOver, context);
    sendJson(res, 200, {
      id: takeOver.id,
      reason: takeOver.reason,
      path: `${TAKE_OVER_STREAM_PATH}?token=${token}`,
    });
    return;
  }
  if (pathname === TAKE_OVER_FINISH_PATH) {
    const takeOver = requireTakeOver(body.id);
    if (takeOver.state !== 'finished') {
      takeOver.remember = body.remember === true;
      takeOver.state = 'finished';
      audit('browser.take_over_finished', takeOver, context);
      disconnect(takeOver);
      // Kept for the worker's next status poll, which then closes it.
      takeOver.expiresAt = Math.min(takeOver.expiresAt, Date.now() + 60_000);
    }
    sendJson(res, 200, { finished: true, remember: takeOver.remember });
    return;
  }
  throw new GatewayRequestError(404, 'Not Found');
}

export function consumeTakeOverStreamToken(token: string): string | null {
  prune();
  const entry = streamTokens.get(token);
  if (!entry) return null;
  streamTokens.delete(token);
  return entry.id;
}

const WebSocketServerCtor = (
  wsModule as unknown as {
    WebSocketServer: new (options: {
      noServer: true;
      maxPayload: number;
    }) => {
      handleUpgrade: (
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        cb: (ws: WebSocket) => void,
      ) => void;
    };
  }
).WebSocketServer;

const wss = new WebSocketServerCtor({
  noServer: true,
  maxPayload: MAX_INPUT_BYTES,
});

/** Relay between the phone and the stream server of the take-over's browser. */
export function handleTakeOverUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  id: string,
): void {
  wss.handleUpgrade(req, socket, head, (client: WebSocket) => {
    const takeOver = takeOvers.get(id);
    if (!takeOver || takeOver.state === 'finished') {
      client.close(1008, 'Take-over ended');
      return;
    }
    // A second phone (or a reconnect) replaces the first.
    takeOver.client?.close(1000, 'Replaced');
    takeOver.upstream?.close();
    takeOver.client = client;
    takeOver.state = 'active';
    const upstream = new WebSocket(`ws://127.0.0.1:${takeOver.port}`, {
      maxPayload: MAX_FRAME_BYTES * 2,
    });
    takeOver.upstream = upstream;
    upstream.on('message', (data) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const out = toClientMessage(String(data));
      if (!out) return;
      if (
        out.type === 'frame' &&
        client.bufferedAmount > MAX_CLIENT_BUFFER_BYTES
      ) {
        return;
      }
      client.send(JSON.stringify(out));
    });
    upstream.on('error', (err) => {
      logger.debug({ err, takeOverId: id }, 'Take-over stream failed');
      client.close(1011, 'Browser stream unavailable');
    });
    upstream.on('close', () => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, 'Browser stream closed');
      }
    });
    client.on('message', (data) => {
      const input = toBrowserInput(String(data));
      if (input && upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify(input));
      }
    });
    client.on('close', () => {
      if (takeOver.client === client) {
        takeOver.client = null;
        upstream.close();
      }
    });
  });
}

function finite(value: unknown, min: number, max: number): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

const MOUSE_EVENTS = new Set([
  'mousePressed',
  'mouseReleased',
  'mouseMoved',
  'mouseWheel',
]);
const MOUSE_BUTTONS = new Set(['left', 'middle', 'right', 'none']);
const KEY_EVENTS = new Set(['keyDown', 'keyUp', 'char']);
const TOUCH_EVENTS = new Set([
  'touchStart',
  'touchMove',
  'touchEnd',
  'touchCancel',
]);

/** Rebuild the phone's input from known fields only; anything else is dropped. */
export function toBrowserInput(raw: string): Record<string, unknown> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
  const modifiers = finite(parsed.modifiers, 0, 15) ?? 0;
  if (parsed.type === 'input_mouse') {
    const eventType = String(parsed.eventType);
    const x = finite(parsed.x, 0, 10_000);
    const y = finite(parsed.y, 0, 10_000);
    if (!MOUSE_EVENTS.has(eventType) || x === null || y === null) return null;
    const button = String(parsed.button ?? 'none');
    return {
      type: 'input_mouse',
      eventType,
      x,
      y,
      button: MOUSE_BUTTONS.has(button) ? button : 'none',
      clickCount: Math.round(finite(parsed.clickCount, 0, 3) ?? 0),
      modifiers: Math.round(modifiers),
      ...(eventType === 'mouseWheel'
        ? {
            deltaX: finite(parsed.deltaX, -10_000, 10_000) ?? 0,
            deltaY: finite(parsed.deltaY, -10_000, 10_000) ?? 0,
          }
        : {}),
    };
  }
  if (parsed.type === 'input_keyboard') {
    const eventType = String(parsed.eventType);
    const key = text(parsed.key, 32);
    if (!KEY_EVENTS.has(eventType) || !key) return null;
    const keyText =
      typeof parsed.text === 'string' ? parsed.text.slice(0, 8) : '';
    return {
      type: 'input_keyboard',
      eventType,
      key,
      code: text(parsed.code, 32),
      ...(keyText ? { text: keyText } : {}),
      windowsVirtualKeyCode: Math.round(
        finite(parsed.windowsVirtualKeyCode, 0, 255) ?? 0,
      ),
      modifiers: Math.round(modifiers),
    };
  }
  if (parsed.type === 'input_touch') {
    const eventType = String(parsed.eventType);
    if (!TOUCH_EVENTS.has(eventType) || !Array.isArray(parsed.touchPoints)) {
      return null;
    }
    const touchPoints = parsed.touchPoints.slice(0, 5).flatMap((point) => {
      const x = finite(asRecord(point).x, 0, 10_000);
      const y = finite(asRecord(point).y, 0, 10_000);
      return x === null || y === null ? [] : [{ x, y }];
    });
    if (touchPoints.length === 0 && eventType !== 'touchEnd') return null;
    return {
      type: 'input_touch',
      eventType,
      touchPoints,
      modifiers: Math.round(modifiers),
    };
  }
  return null;
}

/** The stream server's frames and active tab, in the phone's terms. */
export function toClientMessage(raw: string): Record<string, unknown> | null {
  if (raw.length > MAX_FRAME_BYTES) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
  if (parsed.type === 'frame' && typeof parsed.data === 'string') {
    const metadata = asRecord(parsed.metadata);
    return {
      type: 'frame',
      data: parsed.data,
      width: finite(metadata.deviceWidth, 0, 10_000) ?? 0,
      height: finite(metadata.deviceHeight, 0, 10_000) ?? 0,
    };
  }
  if (parsed.type === 'tabs' && Array.isArray(parsed.tabs)) {
    const active = parsed.tabs.map(asRecord).find((tab) => tab.active === true);
    if (!active) return null;
    const url = displayUrl(active.url);
    // A page without a title of its own is named by its whole address,
    // query included.
    const title = text(active.title, 200);
    const host = url ? new URL(url).host : '';
    return {
      type: 'page',
      url,
      title: host && title.startsWith(host) ? '' : title,
    };
  }
  return null;
}

// Origin and path, as browser frames show a page: a query can hold tokens.
function displayUrl(raw: unknown): string {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

export function resetBrowserTakeOversForTests(): void {
  for (const takeOver of takeOvers.values()) end(takeOver);
  streamTokens.clear();
}
